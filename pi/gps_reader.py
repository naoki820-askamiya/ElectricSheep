"""USB GPS から現在地を読み取り、最新の測位結果をメモリに保持する。

単体で動作確認できる:
    ./venv/bin/python gps_reader.py

■ なぜ常時読み続けるのか
GPS の初回測位（コールドスタート）は実測で26秒かかった。要求されてから
ポートを開くと、返事までその時間待たせることになる。
起動中ずっと読み続けてキャッシュし、要求には即座に答える。

サーバーへ送るのは location_request を受け取ったときだけ。
常時送信しないので、位置が絶えず外へ出ることはない。

■ gpsd と同時に使えない
どちらもシリアルポートを占有する。gpsd が動いていると
「データが出てこない」状態になる。停止では復活することがあるので mask する。

    sudo systemctl mask gpsd.socket gpsd.service
    sudo pkill -x gpsd
    sudo fuser -v /dev/ttyACM0     # 誰が掴んでいるか

さらに gpsd は u-blox へ設定コマンドを送る。実機では gpsd を動かしたあと
GGA が出なくなった。u-blox は設定をバックアップ電源付きメモリに持つため、
USBを抜き差ししても戻らない。そのため GGA が無ければ RMC から位置を取る。
RMC には衛星数と HDOP が無いので、accuracy は None になる。

実機で確認した値と注意点は docs/gps-notes.md にある。
"""
from __future__ import annotations

import glob
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

try:
    import serial
except ImportError:  # pyserial が無くても音声機能は動かしたい
    serial = None

BAUD = int(os.environ.get("PASSEN_GPS_BAUD", "9600"))
PORT = os.environ.get("PASSEN_GPS_PORT") or None

# キャッシュした座標を有効とみなす秒数。車は動くので、古い座標は嘘になる
MAX_AGE_SEC = float(os.environ.get("PASSEN_GPS_MAX_AGE_SEC", "15"))

# 要求を受けてから測位を待つ最大秒数。これを過ぎたらエラーを返す
TIMEOUT_SEC = float(os.environ.get("PASSEN_GPS_TIMEOUT_SEC", "5"))

RECONNECT_MAX_SEC = 8.0


class GPSUnavailable(Exception):
    """現在地を返せないときに投げる。code はサーバーへそのまま渡す。

    NO_DEVICE … GPSが挿さっていない、pyserial が無い、ポートを開けない
    NO_FIX    … 受信できているが衛星が足りず測位できていない
    STALE     … 測位はしたが古すぎる（トンネルに入った直後など）
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Fix:
    """測位結果。

    GGA が使えるときは衛星数と HDOP まで取れるが、受信機の設定で GGA が
    無効化されていると RMC しか流れてこない。RMC には位置と有効フラグしか
    無いので、精度に関わる項目は None になりうる。
    """

    lat: float
    lng: float
    measured_at: float                 # time.time()
    accuracy: float | None = None      # 水平誤差の推定値（メートル）
    satellites: int | None = None
    hdop: float | None = None
    source: str = "GGA"                # どの文から得たか。ログの手がかり

    def measured_at_iso(self) -> str:
        return (
            datetime.fromtimestamp(self.measured_at, timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )


def find_port() -> str | None:
    """仕様書の優先順位で探す。by-id を先に見るのは、挿し直しで
    ttyACM の番号がずれても同じ名前で辿れるため。"""
    if PORT:
        return PORT
    for pattern in ("/dev/serial/by-id/*", "/dev/ttyACM*", "/dev/ttyUSB*"):
        found = sorted(glob.glob(pattern))
        if found:
            return found[0]
    return None


def nmea_checksum_ok(line: str) -> bool:
    """`*` 以降の2桁は、間の全文字のXOR。壊れた行を弾く。"""
    if not line.startswith("$") or "*" not in line:
        return False
    body, _, checksum = line[1:].partition("*")
    try:
        expected = int(checksum[:2], 16)
    except ValueError:
        return False
    actual = 0
    for char in body:
        actual ^= ord(char)
    return actual == expected


def to_degrees(value: str, hemisphere: str) -> float:
    """NMEA の「度分」を10進度に直す。

    3504.2241 は 35度4.2241分。35.042241度ではない。
    ここを間違えると数十km ずれる。
    """
    point = value.index(".")
    degrees = int(value[: point - 2])
    minutes = float(value[point - 2 :])
    result = degrees + minutes / 60
    return -result if hemisphere in ("S", "W") else result


def parse_gga(line: str) -> Fix | None:
    """$--GGA から測位結果を取り出す。未測位なら None。

    話者IDは受信機や衛星系によって GP/GN/GL と変わるので、真ん中は見ない。
    """
    parts = line.split(",")
    if len(parts) < 10 or not parts[0].endswith("GGA"):
        return None

    quality = parts[6]
    if not quality or quality == "0":
        return None                      # 0 = 未測位。座標は空か無意味
    if not (parts[2] and parts[4]):
        return None

    try:
        lat = to_degrees(parts[2], parts[3])
        lng = to_degrees(parts[4], parts[5])
        satellites = int(parts[7] or 0)
        hdop = float(parts[8] or 99.9)
    except (ValueError, IndexError):
        return None

    # GGA は誤差そのものを持たない。HDOP から概算する。
    #
    # 係数はこの機体の実測に合わせた。cgps が HDOP 1.13 のときに
    # 水平誤差 ±12m を示したので、12 / 1.13 ≒ 10.6 → 10 とする。
    # 教科書的な 5m/HDOP では半分に見積もってしまい、サーバー側が
    # 実際より高精度だと誤解する。
    accuracy = round(hdop * 10.0, 1)

    return Fix(
        lat=round(lat, 6),
        lng=round(lng, 6),
        measured_at=time.time(),
        accuracy=accuracy,
        satellites=satellites,
        hdop=hdop,
        source="GGA",
    )


def parse_rmc(line: str) -> Fix | None:
    """$--RMC から測位結果を取り出す。未測位なら None。

    GGA が無効化された受信機のための代替。位置と有効フラグは取れるが、
    衛星数と HDOP は含まれないので精度は推定できない。

    実機で gpsd を動かしたあと、GGA が出なくなる事象が起きた。u-blox は
    設定をバックアップ電源付きのメモリに持つため、USBを抜き差ししても
    元に戻らない。特定の文に依存しない作りにしておく。
    """
    parts = line.split(",")
    if len(parts) < 7 or not parts[0].endswith("RMC"):
        return None
    if parts[2] != "A":                  # A=有効 V=無効
        return None
    if not (parts[3] and parts[5]):
        return None

    try:
        lat = to_degrees(parts[3], parts[4])
        lng = to_degrees(parts[5], parts[6])
    except (ValueError, IndexError):
        return None

    return Fix(
        lat=round(lat, 6),
        lng=round(lng, 6),
        measured_at=time.time(),
        source="RMC",
    )


class GPSReader:
    """バックグラウンドで NMEA を読み続け、最新の測位結果を保持する。

    スレッドは1本。読み書きはロックで守る。
    GPSが壊れていても音声会話を止めないよう、例外は外へ出さず状態として持つ。
    """

    def __init__(self, port: str | None = None, baudrate: int = BAUD):
        self._port = port or PORT
        self._baudrate = baudrate
        self._lock = threading.Lock()
        self._fix: Fix | None = None
        self._updated = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._serial = None
        self._last_error: str | None = None
        # GGA が1度でも流れてきたか。流れているなら RMC は無視する
        # （GGA の方が衛星数と HDOP を持つため）
        self._gga_seen = False
        # 受け取った文の種類。設定を疑うときの手がかりになる
        self._sentences: dict[str, int] = {}

    # ------------------------------------------------------------------ #

    def start(self) -> None:
        if serial is None:
            self._last_error = "pyserial が入っていません（pip install pyserial）"
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="gps", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        port = self._serial
        self._serial = None
        if port is not None:
            try:
                port.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

    # ------------------------------------------------------------------ #

    @property
    def status(self) -> str:
        with self._lock:
            fix, error = self._fix, self._last_error
        if fix is None:
            return f"未測位（{error}）" if error else "未測位"
        age = time.time() - fix.measured_at
        detail = f"{fix.lat:.5f}, {fix.lng:.5f}"
        if fix.accuracy is not None:
            detail += f"  ±{fix.accuracy:.0f}m"
        if fix.satellites is not None:
            detail += f"  衛星{fix.satellites}個"
        return f"{detail}  {age:.0f}秒前（{fix.source}）"

    def latest(self) -> Fix | None:
        with self._lock:
            return self._fix

    def sentences(self) -> dict[str, int]:
        """受け取った NMEA 文の種類と回数。

        GGA が 0 なら受信機の設定で無効化されている。gpsd を動かしたあとに
        起きうる（設定はバックアップ電源付きメモリに残り、USBの抜き差しでは
        戻らない）。原因の切り分けに使う。
        """
        with self._lock:
            return dict(self._sentences)

    def get_fix(
        self,
        max_age_sec: float = MAX_AGE_SEC,
        timeout_sec: float = TIMEOUT_SEC,
    ) -> Fix:
        """有効な現在地を返す。返せないときは GPSUnavailable を投げる。

        キャッシュが新しければ即座に返る。古い/無い場合は timeout_sec まで
        新しい測位を待つ。待っても来なければ諦める。
        """
        deadline = time.time() + timeout_sec

        while True:
            with self._lock:
                fix, error = self._fix, self._last_error

            if fix is not None and time.time() - fix.measured_at <= max_age_sec:
                return fix

            if time.time() >= deadline:
                if fix is not None:
                    age = time.time() - fix.measured_at
                    raise GPSUnavailable(
                        "STALE",
                        f"測位が古すぎます（{age:.0f}秒前 / 上限{max_age_sec:.0f}秒）",
                    )
                if serial is None or (error and "pyserial" in error):
                    raise GPSUnavailable("NO_DEVICE", error or "GPSが使えません")
                if self._serial is None:
                    raise GPSUnavailable(
                        "NO_DEVICE", error or "GPSが見つかりません"
                    )
                raise GPSUnavailable(
                    "NO_FIX", "衛星が足りず測位できていません（屋内では出ません）"
                )

            # 新しい行が来たら起こしてもらう。来なくても定期的に見直す
            self._updated.wait(timeout=min(0.5, max(0.0, deadline - time.time())))
            self._updated.clear()

    # ------------------------------------------------------------------ #

    def _run(self) -> None:
        delay = 1.0
        while not self._stop.is_set():
            if not self._open():
                if self._stop.wait(delay):
                    return
                delay = min(delay * 2, RECONNECT_MAX_SEC)
                continue

            delay = 1.0
            try:
                self._read_loop()
            except Exception as e:                     # 切断・USB抜けなど
                self._set_error(f"読み取りに失敗しました: {e}")
            finally:
                port, self._serial = self._serial, None
                if port is not None:
                    try:
                        port.close()
                    except Exception:
                        pass

    def _open(self) -> bool:
        path = self._port or find_port()
        if path is None:
            self._set_error("GPSが見つかりません（/dev/ttyACM* が無い）")
            return False
        try:
            self._serial = serial.Serial(path, self._baudrate, timeout=1.0)
        except Exception as e:
            self._set_error(f"{path} を開けません: {e}")
            return False
        self._set_error(None)
        return True

    def _read_loop(self) -> None:
        port = self._serial
        while not self._stop.is_set() and port is not None:
            raw = port.readline()
            if not raw:
                continue                               # timeout。測位待ちでは普通
            line = raw.decode("ascii", errors="ignore").strip()
            if not nmea_checksum_ok(line):
                continue

            talker = line.split(",", 1)[0]
            with self._lock:
                self._sentences[talker] = self._sentences.get(talker, 0) + 1

            if talker.endswith("GGA"):
                # GGA が流れているなら、それだけを信じる。RMC より情報が多い
                self._gga_seen = True
                fix = parse_gga(line)
            elif talker.endswith("RMC") and not self._gga_seen:
                # GGA が無効化された受信機のための代替
                fix = parse_rmc(line)
            else:
                continue

            if fix is None:
                continue
            with self._lock:
                self._fix = fix
            self._updated.set()

    def _set_error(self, message: str | None) -> None:
        with self._lock:
            self._last_error = message


# ---------------------------------------------------------------------- #
# 単体での動作確認
# ---------------------------------------------------------------------- #

def _main() -> None:
    reader = GPSReader()
    reader.start()
    path = reader._port or find_port()
    print(f"ポート: {path or '見つかりません'} / {BAUD}bps")
    print("測位を待っています（Ctrl+C で終了）")
    print("屋内では測位できないことがあります。空が見える場所で試してください。\n")
    try:
        while True:
            print(f"  {reader.status}")
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\n終了します")
    finally:
        reader.close()


if __name__ == "__main__":
    _main()
