"""パッセン車載デバイス本体。

ウェイクワードで起き、声を WebSocket でサーバーへ流し、返事の音声を鳴らす。
やり取りの仕様は docs/websocket-protocol.md を参照。

    pip install websocket-client
    PASSEN_WS=ws://192.168.1.10:8080/ws ./venv/bin/python passen_ws.py

■ 設計の要点
1. 待ち受け中はマイクの音を外へ出さない。
   ウェイクワード検出は Pi 内で完結する。プライバシー上これは譲れない。
2. 再生中はマイクを捨てる。
   自分の声で再検出するのを防ぐ。割り込み発話ができなくなる代わりに、
   エコーキャンセル付きの高価なデバイスが要らなくなる。
3. マイクは1本の arecord を使い回す。
   開き直すと ALSA が数百ms 止まり、その間の発話が丸ごと落ちる。
4. 位置情報は要求されたときだけ返す。
   GPS は常時読んでキャッシュするが、外へ送るのは location_request を
   受けたときのみ。詳細は gps_reader.py と docs/gps-notes.md。
"""
import json
import os
import re
import select
import subprocess
import tempfile
import time
from urllib.parse import urlencode

import numpy as np
import websocket
from openwakeword.model import Model as WakeModel

from gps_reader import GPSReader, GPSUnavailable

SAMPLE_RATE = 16000
FRAME = 1280              # 80ms。openWakeWord の想定に合わせている
THRESHOLD = 0.35          # ウェイクワードの判定。誤検出が増えたら上げる

# 発話の終わりの判定。
# 固定値では場所が変わると合わない（実測: 室内の暗騒音の底が 265〜510 あり、
# 当初の 400 では一度も無音と判定されなかった）。起動時に環境音を測り、
# その倍率で基準を決める。
SILENCE_MARGIN = 2.5      # 暗騒音の何倍を発話とみなすか
SILENCE_RMS_MIN = 500     # 静かすぎる場所での下限
SILENCE_RMS_MAX = 3000    # うるさすぎる場所での上限
SILENCE_SEC = 1.2         # 話し終わってから、これだけ沈黙したら終了
SPEECH_START_SEC = 5.0    # 呼びかけてから話し始めるまでの猶予
UTTERANCE_MAX_SEC = 10.0  # 話し始めてからの上限

COOLDOWN_SEC = 1.0        # 再生後、待ち受けに戻るまでの間
PING_SEC = 30.0

WS_URL = os.environ.get("PASSEN_WS", "ws://localhost:8080/ws")
WAKE_MODEL = os.environ.get("PASSEN_WAKE", "passenger.onnx")
USER_ID = os.environ.get("PASSEN_USER", "pi-demo")
DEVICE = os.environ.get("PASSEN_DEVICE", "raspberrypi-4")

# GPS が無い機体でも音声会話は動かしたいので、切れるようにしてある
USE_GPS = os.environ.get("PASSEN_GPS", "on").lower() not in ("off", "0", "false")

# 常時読み続ける GPS。main() で作る。要求が来たときだけ参照する
GPS: GPSReader | None = None


def list_cards(cmd: str, skip: str) -> list[str]:
    """arecord -l / aplay -l から USB 機器の card 番号を拾う。
    Pi 内蔵の HDMI・イヤホン端子は skip で除外する。"""
    out = subprocess.run([cmd, "-l"], capture_output=True, text=True).stdout
    found = []
    for line in out.splitlines():
        m = re.match(r"card (\d+):", line)
        if m and not re.search(skip, line, re.I) and m.group(1) not in found:
            found.append(m.group(1))
    if not found:
        raise SystemExit(f"{cmd} -l で機器が見つかりません")
    return found


MIC_CARD = os.environ.get("PASSEN_MIC") or list_cards("arecord", r"vc4hdmi|bcm2835")[0]

# USB マイクは再生デバイスも持っていることが多く、先頭を取るとマイクを
# スピーカーとして掴んでしまう。マイク以外を優先する。
_spk = os.environ.get("PASSEN_SPK")
if not _spk:
    cards = list_cards("aplay", r"Headphones|vc4hdmi|bcm2835")
    others = [c for c in cards if c != MIC_CARD]
    _spk = others[0] if others else cards[0]
SPK_CARD = _spk


def rms(data: bytes) -> float:
    audio = np.frombuffer(data, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(audio * audio)))


def calibrate(mic, seconds: float = 1.0) -> float:
    """その場の環境音を測り、無音とみなす基準を決める。
    車内と室内では暗騒音が大きく違うため、固定値だと必ずどちらかで外れる。"""
    levels = []
    for _ in range(int(seconds * SAMPLE_RATE / FRAME)):
        data = mic.stdout.read(FRAME * 2)
        if not data:
            break
        levels.append(rms(data))
    if not levels:
        return SILENCE_RMS_MIN
    floor = sorted(levels)[len(levels) // 2]   # 中央値。突発音に引きずられない
    return min(SILENCE_RMS_MAX, max(SILENCE_RMS_MIN, floor * SILENCE_MARGIN))


def open_mic() -> subprocess.Popen:
    return subprocess.Popen(
        ["arecord", "-q", "-D", f"plughw:{MIC_CARD},0",
         "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE), "-t", "raw"],
        stdout=subprocess.PIPE,
    )


def drain(stream) -> None:
    """溜まったマイク入力を捨てる。再生中に入った自分の声を持ち越さないため。"""
    fd = stream.fileno()
    os.set_blocking(fd, False)
    try:
        while stream.read(1 << 16):
            pass
    except BlockingIOError:
        pass
    finally:
        os.set_blocking(fd, True)


def make_beep() -> str:
    """呼びかけに気づいたことを音で返す。画面を見ない前提なので必須。"""
    import wave

    path = os.path.join(tempfile.gettempdir(), "passen_beep.wav")
    t = np.linspace(0, 0.12, int(SAMPLE_RATE * 0.12), endpoint=False)
    tone = (np.sin(2 * np.pi * 880 * t) * 0.3 * 32767).astype(np.int16)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        f.writeframes(tone.tobytes())
    return path


BEEP = make_beep()


def play_file(path: str) -> None:
    subprocess.run(["aplay", "-q", "-D", f"plughw:{SPK_CARD},0", path],
                   stderr=subprocess.DEVNULL)


def open_raw_player(rate: int, channels: int) -> subprocess.Popen:
    """生の PCM を流し込んで即座に鳴らす。全部届くのを待たずに再生できる。"""
    return subprocess.Popen(
        ["aplay", "-q", "-D", f"plughw:{SPK_CARD},0",
         "-f", "S16_LE", "-c", str(channels), "-r", str(rate), "-t", "raw"],
        stdin=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )


class Session:
    """1本の WebSocket 接続。切れたら上位で作り直す。"""

    def __init__(self, ws: websocket.WebSocket):
        self.ws = ws
        self.last_ping = time.time()

    def send(self, payload: dict) -> None:
        self.ws.send(json.dumps(payload))

    def recv_json(self) -> dict:
        """テキストメッセージが来るまで読む。バイナリは呼び出し側が扱う。"""
        while True:
            opcode, data = self.ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_TEXT:
                return json.loads(data.decode())
            if opcode == websocket.ABNF.OPCODE_BINARY:
                # 想定外の位置で来たバイナリは捨てる（再生は receive_audio が担当）
                continue
            if opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("サーバーが接続を閉じました")

    def maybe_ping(self) -> None:
        if time.time() - self.last_ping >= PING_SEC:
            self.send({"type": "ping"})
            self.last_ping = time.time()


def answer_location(session: Session, request_id) -> None:
    """サーバーからの位置情報要求に答える。

    測位できていなくても必ず返す。無応答だとサーバーが数秒待たされ、
    その間ユーザーは無言のAIを見つめることになる。
    """
    if GPS is None:
        session.send({
            "type": "location_error",
            "requestId": request_id,
            "code": "NO_DEVICE",
            "message": "GPSを使わない設定で起動しています",
        })
        print("  [位置情報] GPS無効のため NO_DEVICE を返しました")
        return

    try:
        fix = GPS.get_fix()
    except GPSUnavailable as e:
        session.send({
            "type": "location_error",
            "requestId": request_id,
            "code": e.code,
            "message": str(e),
        })
        print(f"  [位置情報] {e.code}: {e}")
        return

    session.send({
        "type": "location_result",
        "requestId": request_id,
        "lat": fix.lat,
        "lng": fix.lng,
        "accuracy": fix.accuracy,
        "measuredAt": fix.measured_at_iso(),
    })
    print(
        f"  [位置情報] {fix.lat:.5f}, {fix.lng:.5f} "
        f"±{fix.accuracy:.0f}m（衛星{fix.satellites}個）を返しました"
    )


def handle_control(session: Session, msg: dict) -> bool:
    """会話の本筋に関係しない制御メッセージを処理する。扱ったら True。

    どのタイミングでも届きうるので、待ち受け中・応答待ち中・再生中の
    3箇所から同じ関数を呼んでいる。
    """
    kind = msg.get("type")

    if kind == "location_request":
        answer_location(session, msg.get("requestId"))
        return True

    if kind in ("pong", "listen", "conversation_ended"):
        # listen / conversation_ended はサーバー側の多ターン会話用。
        # 今の Pi は毎回ウェイクワードを待つので、受け流すだけでよい。
        return True

    return False


def poll_control(session: Session) -> None:
    """待ち受け中に届いた制御メッセージを、マイクを止めずに処理する。

    ここを読まないと location_request が滞留し、サーバーが
    タイムアウトするまで返事ができない。
    """
    sock = session.ws.sock
    if sock is None:
        return

    while select.select([sock], [], [], 0)[0]:
        # 枠が途中まで届いた状態で固まらないよう、上限を置いて読む
        sock.settimeout(0.3)
        try:
            opcode, data = session.ws.recv_data()
        except (websocket.WebSocketTimeoutException, OSError):
            return
        finally:
            sock.settimeout(None)

        if opcode == websocket.ABNF.OPCODE_CLOSE:
            raise ConnectionError("サーバーが接続を閉じました")
        if opcode != websocket.ABNF.OPCODE_TEXT:
            continue

        msg = json.loads(data.decode())
        if not handle_control(session, msg):
            print(f"  [待ち受け中に想定外のメッセージ: {msg.get('type')}]")


def stream_utterance(session: Session, mic, silence_rms: float) -> None:
    """発話が終わるまでマイクの音を送り続ける。終わったら end を送る。

    ■「話し始めるまで」と「話し終わってから」を分けている理由
    人は呼びかけたあと少し考える。両方を同じ 1.2 秒で測ると、
    「えーと」の間に打ち切られ、本題が一切録れない。
    実測でこれが起き、4回とも 1.3 秒（＝沈黙のみ）で終了していた。
    """
    start = time.time()
    speech_start: float | None = None   # None のうちはまだ話し始めていない
    silent_since: float | None = None

    while True:
        data = mic.stdout.read(FRAME * 2)
        if not data:
            raise ConnectionError("マイクが停止しました")

        session.ws.send_binary(data)

        now = time.time()
        loud = rms(data) >= silence_rms

        if loud:
            if speech_start is None:
                speech_start = now
            silent_since = None
        elif speech_start is not None:
            # 話し始めたあとの沈黙だけを、発話の終わりとして数える
            if silent_since is None:
                silent_since = now
            elif now - silent_since >= SILENCE_SEC:
                session.send({"type": "end", "reason": "silence"})
                return

        if speech_start is None:
            if now - start >= SPEECH_START_SEC:
                # 呼びかけただけで何も話さなかった場合。
                # サーバーは音声認識もLLMも呼ばずに済む
                session.send({"type": "end", "reason": "no_speech"})
                return
        elif now - speech_start >= UTTERANCE_MAX_SEC:
            session.send({"type": "end", "reason": "timeout"})
            return


def on_text_during_audio(session: Session, msg: dict) -> None:
    """再生中に届いたテキストを処理する。

    サーバーは audio_start → 音声 → reply → audio_end の順で送るため、
    ここで拾わないと返事の文が読み飛ばされる。
    """
    kind = msg.get("type")

    if kind == "reply":
        print(f"  パッセン: {msg.get('text', '')}")
        place = msg.get("suggestedPlace")
        if place:
            print(f"  （提案: {place.get('name')}）")
    elif kind == "transcript":
        mark = "" if msg.get("final") else "…"
        print(f"  あなた: {msg.get('text', '')}{mark}")
    elif kind == "error":
        print(f"  [エラー {msg.get('code')}] {msg.get('message')}")
    elif not handle_control(session, msg):
        print(f"  [未知のメッセージ: {kind}]")


def receive_audio(session: Session, fmt: dict) -> None:
    """audio_start を受けた後の音声を鳴らす。audio_end まで読み続ける。"""
    encoding = fmt.get("encoding", "pcm_s16le")

    if encoding == "wav":
        chunks: list[bytes] = []
        while True:
            opcode, data = session.ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_BINARY:
                chunks.append(data)
            elif opcode == websocket.ABNF.OPCODE_TEXT:
                msg = json.loads(data.decode())
                if msg.get("type") == "audio_end":
                    break
                on_text_during_audio(session, msg)
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("再生中に接続が切れました")

        path = os.path.join(tempfile.gettempdir(), "passen_reply.wav")
        with open(path, "wb") as f:
            f.write(b"".join(chunks))
        play_file(path)
        return

    player = open_raw_player(fmt.get("sampleRate", 24000), fmt.get("channels", 1))
    try:
        while True:
            opcode, data = session.ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_BINARY:
                player.stdin.write(data)
            elif opcode == websocket.ABNF.OPCODE_TEXT:
                msg = json.loads(data.decode())
                if msg.get("type") == "audio_end":
                    break
                on_text_during_audio(session, msg)
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("再生中に接続が切れました")
    finally:
        # 閉じてから待つ。閉じないと aplay が入力の終わりに気づかず止まらない
        if player.stdin:
            player.stdin.close()
        player.wait()


def handle_turn(session: Session, mic, silence_rms: float) -> None:
    """呼びかけ1回ぶん。送信 → 返事の受信 → 再生まで。"""
    stream_utterance(session, mic, silence_rms)

    while True:
        msg = session.recv_json()
        kind = msg.get("type")

        if kind == "transcript":
            mark = "" if msg.get("final") else "…"
            print(f"  あなた: {msg.get('text', '')}{mark}")
        elif kind == "reply":
            print(f"  パッセン: {msg.get('text', '')}")
            place = msg.get("suggestedPlace")
            if place:
                print(f"  （提案: {place.get('name')}）")
        elif kind == "audio_start":
            receive_audio(session, msg)
            return
        elif kind == "error":
            print(f"  [エラー {msg.get('code')}] {msg.get('message')}")
            return
        elif handle_control(session, msg):
            continue
        else:
            print(f"  [未知のメッセージ: {kind}]")


def run_once(wake: WakeModel) -> None:
    """接続してから切れるまで。切断は呼び出し側が再接続で拾う。"""
    print(f"接続中: {WS_URL}")
    url = f"{WS_URL}?{urlencode({'userId': USER_ID})}"
    ws = websocket.create_connection(url, timeout=30)
    session = Session(ws)

    session.send({
        "type": "hello",
        "userId": USER_ID,
        "device": DEVICE,
        "audio": {"encoding": "pcm_s16le", "sampleRate": SAMPLE_RATE, "channels": 1},
    })

    ready = session.recv_json()
    if ready.get("type") != "ready":
        raise ConnectionError(f"ready が返りません: {ready}")

    print(f"接続しました（session {ready.get('sessionId')}）")
    print("\n「パッセンジャー」と呼びかけてください（Ctrl+C で終了）\n")

    mic = open_mic()
    try:
        silence_rms = calibrate(mic)
        print(f"環境音から決めた無音の基準: {silence_rms:.0f}")
        wake.reset()

        while True:
            data = mic.stdout.read(FRAME * 2)
            if not data:
                raise ConnectionError("マイクが停止しました")

            scores = wake.predict(np.frombuffer(data, dtype=np.int16))
            score = max(scores.values())

            if score <= THRESHOLD:
                session.maybe_ping()
                poll_control(session)
                continue

            print(f"[検出 {score:.2f}] どうぞ")
            session.send({
                "type": "wake",
                "score": round(float(score), 3),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            play_file(BEEP)
            drain(mic.stdout)   # ビープ音を発話として送らないため

            handle_turn(session, mic, silence_rms)

            drain(mic.stdout)
            wake.reset()
            time.sleep(COOLDOWN_SEC)
            drain(mic.stdout)
            wake.reset()
            print()
    finally:
        mic.terminate()
        ws.close()


def main() -> None:
    global GPS

    print("モデルを読み込んでいます…")
    wake = WakeModel(wakeword_model_paths=[WAKE_MODEL])
    print(f"マイク: card {MIC_CARD} / スピーカー: card {SPK_CARD}")

    if USE_GPS:
        # 接続より先に始める。コールドスタートに実測26秒かかるので、
        # 会話が始まる前から測位させておきたい
        GPS = GPSReader()
        GPS.start()
        print(f"GPS: {GPS.status}")
    else:
        print("GPS: 無効（PASSEN_GPS=off）")

    try:
        delay = 1.0
        while True:
            try:
                run_once(wake)
                delay = 1.0
            except KeyboardInterrupt:
                print("\n終了します")
                return
            except (websocket.WebSocketException, ConnectionError, OSError) as e:
                print(f"切断: {e}")
                print(f"{delay:.0f}秒後に再接続します")
                try:
                    time.sleep(delay)
                except KeyboardInterrupt:
                    print("\n終了します")
                    return
                delay = min(delay * 2, 8.0)   # 1 → 2 → 4 → 8 秒で頭打ち
    finally:
        if GPS is not None:
            GPS.close()


if __name__ == "__main__":
    main()
