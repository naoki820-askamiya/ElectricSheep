"""GPS受信機の設定を工場出荷時に戻す。

    ./venv/bin/python gps_reset.py

■ 何のために要るのか
gpsd は u-blox へ UBX コマンドを送り、出力する NMEA 文の種類を変更する。
実機では gpsd を動かしたあと GGA と GSV が出なくなった。

u-blox は設定をバックアップ電源付きメモリ（BBR）に保持するため、
USBを抜き差ししても元に戻らない。コマンドで戻すしかない。

GSV が出ないと衛星が何個見えているか分からず、「あと少しで測位する」のか
「電波が届いていない」のかを切り分けられない。

■ 実行後
受信機は既定の設定に戻り、GGA / GSA / GSV / RMC などが1秒ごとに流れる。
軌道情報も消えるので、次の測位はコールドスタート（30秒〜数分）になる。

事前に gpsd を止めておくこと。ポートを掴まれていると送れない。

    sudo systemctl mask gpsd.socket gpsd.service
    sudo pkill -x gpsd
"""
from __future__ import annotations

import sys
import time

try:
    import serial
except ImportError:
    print("pyserial が入っていません: pip install pyserial")
    sys.exit(1)

from gps_reader import BAUD, find_port


def ubx(cls: int, mid: int, payload: bytes = b"") -> bytes:
    """UBX パケットを組む。末尾2バイトはクラス以降の総和チェックサム。"""
    body = bytes([cls, mid]) + len(payload).to_bytes(2, "little") + payload
    ck_a = ck_b = 0
    for byte in body:
        ck_a = (ck_a + byte) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return b"\xb5\x62" + body + bytes([ck_a, ck_b])


def factory_reset_packet() -> bytes:
    """CFG-CFG: 保存された設定を消し、既定値を読み込む。

    clearMask=0xFFFF … 全部消す
    saveMask=0x0000  … 保存はしない
    loadMask=0xFFFF  … 既定値を読み込む
    deviceMask=0x17  … BBR / Flash / EEPROM / SPI Flash すべて
    """
    payload = (
        (0xFFFF).to_bytes(4, "little")
        + (0).to_bytes(4, "little")
        + (0xFFFF).to_bytes(4, "little")
        + bytes([0x17])
    )
    return ubx(0x06, 0x09, payload)


def main() -> None:
    path = find_port()
    if path is None:
        print("GPSが見つかりません（/dev/ttyACM* が無い）")
        sys.exit(1)

    packet = factory_reset_packet()
    print(f"ポート: {path} / {BAUD}bps")
    print("送信: " + " ".join(f"{b:02X}" for b in packet))

    try:
        with serial.Serial(path, BAUD, timeout=1.0) as port:
            port.write(packet)
            port.flush()
            print("送信しました。受信機が再起動します\n")

            # 戻ったかどうかは、届く文の種類で判断できる
            time.sleep(2.0)
            seen: dict[str, int] = {}
            deadline = time.time() + 8.0
            while time.time() < deadline:
                raw = port.readline()
                if not raw:
                    continue
                line = raw.decode("ascii", errors="ignore").strip()
                if line.startswith("$"):
                    name = line.split(",", 1)[0]
                    seen[name] = seen.get(name, 0) + 1
    except Exception as e:
        print(f"失敗しました: {e}")
        print("gpsd がポートを掴んでいないか確認してください")
        print("  sudo fuser -v /dev/ttyACM0")
        sys.exit(1)

    print("--- 8秒間に届いた NMEA 文 ---")
    if not seen:
        print("  何も届きません。USBを抜き差ししてから試してください")
        sys.exit(1)
    for name, count in sorted(seen.items(), key=lambda x: -x[1]):
        print(f"  {name}: {count}回")

    has_gga = any(n.endswith("GGA") for n in seen)
    has_gsv = any(n.endswith("GSV") for n in seen)
    print()
    if has_gga and has_gsv:
        print("成功です。GGA と GSV が戻りました。")
        print("次は屋外で測位を待ってください:")
        print("  ./venv/bin/python gps_reader.py")
    else:
        missing = [n for n, ok in (("GGA", has_gga), ("GSV", has_gsv)) if not ok]
        print(f"{' と '.join(missing)} がまだ出ていません。")
        print("USBを抜き差ししてから、もう一度実行してみてください。")


if __name__ == "__main__":
    main()
