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
"""
import json
import os
import re
import subprocess
import tempfile
import time
from urllib.parse import urlencode

import numpy as np
import websocket
from openwakeword.model import Model as WakeModel

SAMPLE_RATE = 16000
FRAME = 1280              # 80ms。openWakeWord の想定に合わせている
THRESHOLD = 0.35          # ウェイクワードの判定。誤検出が増えたら上げる

# 発話の終わりの判定。車内は暗騒音があるので RMS はやや高めに取る
SILENCE_RMS = 400
SILENCE_SEC = 1.2
UTTERANCE_MAX_SEC = 10.0

COOLDOWN_SEC = 1.0        # 再生後、待ち受けに戻るまでの間
PING_SEC = 30.0

WS_URL = os.environ.get("PASSEN_WS", "ws://localhost:8080/ws")
WAKE_MODEL = os.environ.get("PASSEN_WAKE", "passenger.onnx")
USER_ID = os.environ.get("PASSEN_USER", "pi-demo")
DEVICE = os.environ.get("PASSEN_DEVICE", "raspberrypi-4")


def find_card(cmd: str, skip: str) -> str:
    """arecord -l / aplay -l から USB 機器の card 番号を拾う。
    Pi 内蔵の HDMI・イヤホン端子は skip で除外する。"""
    out = subprocess.run([cmd, "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):", line)
        if m and not re.search(skip, line, re.I):
            return m.group(1)
    raise SystemExit(f"{cmd} -l で機器が見つかりません")


MIC_CARD = os.environ.get("PASSEN_MIC") or find_card("arecord", r"vc4hdmi|bcm2835")
SPK_CARD = os.environ.get("PASSEN_SPK") or find_card(
    "aplay", r"Headphones|vc4hdmi|bcm2835"
)


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


def stream_utterance(session: Session, mic) -> None:
    """無音になるまでマイクの音を送り続ける。終わったら end を送る。"""
    start = time.time()
    silent_since: float | None = None

    while True:
        data = mic.stdout.read(FRAME * 2)
        if not data:
            raise ConnectionError("マイクが停止しました")

        session.ws.send_binary(data)

        audio = np.frombuffer(data, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(audio * audio)))
        now = time.time()

        if rms < SILENCE_RMS:
            if silent_since is None:
                silent_since = now
            elif now - silent_since >= SILENCE_SEC:
                session.send({"type": "end", "reason": "silence"})
                return
        else:
            silent_since = None

        if now - start >= UTTERANCE_MAX_SEC:
            session.send({"type": "end", "reason": "timeout"})
            return


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
                if json.loads(data.decode()).get("type") == "audio_end":
                    break
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
                if json.loads(data.decode()).get("type") == "audio_end":
                    break
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("再生中に接続が切れました")
    finally:
        # 閉じてから待つ。閉じないと aplay が入力の終わりに気づかず止まらない
        if player.stdin:
            player.stdin.close()
        player.wait()


def handle_turn(session: Session, mic) -> None:
    """呼びかけ1回ぶん。送信 → 返事の受信 → 再生まで。"""
    stream_utterance(session, mic)

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
        elif kind == "pong":
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
        while True:
            data = mic.stdout.read(FRAME * 2)
            if not data:
                raise ConnectionError("マイクが停止しました")

            scores = wake.predict(np.frombuffer(data, dtype=np.int16))
            score = max(scores.values())

            if score <= THRESHOLD:
                session.maybe_ping()
                continue

            print(f"[検出 {score:.2f}] どうぞ")
            session.send({
                "type": "wake",
                "score": round(float(score), 3),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            play_file(BEEP)
            drain(mic.stdout)   # ビープ音を発話として送らないため

            handle_turn(session, mic)

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
    print("モデルを読み込んでいます…")
    wake = WakeModel(wakeword_model_paths=[WAKE_MODEL])
    print(f"マイク: card {MIC_CARD} / スピーカー: card {SPK_CARD}")

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


if __name__ == "__main__":
    main()
