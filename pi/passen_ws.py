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
from collections import deque
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

# 無音の基準を決め直すために覚えておく、待ち受け中の直前の音（80ms × 50 = 4秒）。
# 起動時の1秒だけで決めると、あとからエアコンが回るなど車内の音が変わったときに
# 黙っても基準を超え続け、話し終わりを判定できずに10秒の上限まで録り続けてしまう。
AMBIENT_FRAMES = 50
# 話し終わりの判定に使う、直近の沈黙の長さぶんのフレーム数（1.2秒 ÷ 80ms = 15）
TRAIL_FRAMES = int(SILENCE_SEC * SAMPLE_RATE / FRAME)
PING_SEC = 30.0
FOLLOWUP_PREROLL_FRAMES = 5  # 発話検出直前の400msも送り、語頭を欠かさない

WS_URL = os.environ.get("PASSEN_WS", "ws://localhost:8080/ws")
WAKE_MODEL = os.environ.get("PASSEN_WAKE", "passenger.onnx")
USER_ID = os.environ.get("PASSEN_USER", "pi-demo")
DEVICE = os.environ.get("PASSEN_DEVICE", "raspberrypi-4")

# 返事とビープの音量を上げる倍率。スピーカー側を最大にしても小さいときに使う。
# 1.0 で無加工、2.0 でおよそ2倍。上げすぎると音が割れる
VOLUME = float(os.environ.get("PASSEN_VOLUME", "1.0"))

# 返事を鳴らし始めるまでに貯めておく長さ（秒）。0 にすると届いた先から鳴らす。
# 通信が一瞬遅れても、この貯金のぶんは鳴らし続けられるので音が途切れにくい
PREBUFFER_SEC = float(os.environ.get("PASSEN_PREBUFFER", "0.4"))
# 1 にすると aplay の警告（音が間に合わなかった underrun など）を隠さずに出す
DEBUG = os.environ.get("PASSEN_DEBUG", "").strip().lower() not in ("", "0", "off", "false")

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


def threshold_from(levels: list[float], quantile: float = 0.5) -> float:
    """音量の並びから、無音とみなす基準を決める。

    quantile は「静かな方から何割の位置を暗騒音とみなすか」。起動時の測定は
    黙っている前提なので中央値でよいが、待ち受け中の音には人の声が混じりうるので、
    呼び出し側が低めの位置を指定する。
    """
    if not levels:
        return SILENCE_RMS_MIN
    ordered = sorted(levels)
    floor = ordered[min(len(ordered) - 1, int(len(ordered) * quantile))]
    return min(SILENCE_RMS_MAX, max(SILENCE_RMS_MIN, floor * SILENCE_MARGIN))


def calibrate(mic, seconds: float = 1.0) -> float:
    """その場の環境音を測り、無音とみなす基準を決める。
    車内と室内では暗騒音が大きく違うため、固定値だと必ずどちらかで外れる。"""
    levels = []
    for _ in range(int(seconds * SAMPLE_RATE / FRAME)):
        data = mic.stdout.read(FRAME * 2)
        if not data:
            break
        levels.append(rms(data))
    return threshold_from(levels)   # 中央値。突発音に引きずられない


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
    peak = min(0.9, 0.3 * VOLUME)   # 増幅の指定はビープにも効かせる。割れない範囲で
    tone = (np.sin(2 * np.pi * 880 * t) * peak * 32767).astype(np.int16)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        f.writeframes(tone.tobytes())
    return path


BEEP = make_beep()


def amplify(data: bytes, gain: float) -> bytes:
    """再生する音を大きくする。上限を超えた分は頭打ちにして、割れ方を抑える。"""
    if gain == 1.0 or not data:
        return data
    usable = len(data) - (len(data) % 2)   # 16bit なので奇数バイトは端数として残す
    samples = np.frombuffer(data[:usable], dtype=np.int16).astype(np.float32) * gain
    louder = np.clip(samples, -32768, 32767).astype(np.int16).tobytes()
    return louder + data[usable:]


def play_file(path: str) -> None:
    subprocess.run(["aplay", "-q", "-D", f"plughw:{SPK_CARD},0", path],
                   stderr=subprocess.DEVNULL)


def open_raw_player(rate: int, channels: int) -> subprocess.Popen:
    """生の PCM を流し込んで即座に鳴らす。全部届くのを待たずに再生できる。"""
    return subprocess.Popen(
        ["aplay", "-q", "-D", f"plughw:{SPK_CARD},0",
         "-f", "S16_LE", "-c", str(channels), "-r", str(rate), "-t", "raw",
         # スピーカー側にも0.4秒ぶんの余裕を持たせる。既定は短く、届くのが遅れると切れる
         "--buffer-time=400000", "--period-time=80000"],
        stdin=subprocess.PIPE,
        stderr=None if DEBUG else subprocess.DEVNULL,
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

    def recv_json_nowait(self) -> dict | None:
        """届いている制御メッセージがあれば1件だけ返す。音声待機は止めない。"""
        sock = self.ws.sock
        if sock is None:
            raise ConnectionError("サーバーが接続を閉じました")
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return None

        opcode, data = self.ws.recv_data()
        if opcode == websocket.ABNF.OPCODE_TEXT:
            return json.loads(data.decode())
        if opcode == websocket.ABNF.OPCODE_CLOSE:
            raise ConnectionError("サーバーが接続を閉じました")
        return None


def report_end(
    reason: str,
    spoken_sec: float,
    silence_rms: float,
    recent: deque[float],
    peak: float = 0.0,
) -> None:
    """話し終わりをどう判定したかを表示する。返事が遅い・途中で切れるときの手がかり。"""
    if reason == "silence":
        print(f"  [話し終わり: 沈黙で区切り（話した長さ {spoken_sec:.1f}秒）]")
    elif reason == "timeout":
        # 最後の1.2秒で最も静かだった瞬間の音量。これが基準を超えていれば、
        # 黙っていても周りの音が大きく、沈黙と判定できなかったということ
        quietest = min(recent) if recent else 0.0
        print(
            f"  [話し終わり: {UTTERANCE_MAX_SEC:.0f}秒の上限で打ち切り。"
            f"最後の{SILENCE_SEC:g}秒で最も静かな音 {quietest:.0f} / 無音の基準 {silence_rms:.0f}]"
        )
        if quietest >= silence_rms:
            print("  → 黙っていても周りの音が基準を超えています。エアコンなどを止めてから呼びかけてください")
    elif reason == "no_speech":
        print(f"  [話し始めを検出できず（聞こえた最大の音 {peak:.0f} / 基準 {silence_rms:.0f}）]")


def stream_utterance(session: Session, mic, silence_rms: float) -> str:
    """発話が終わるまでマイクの音を送り続ける。終わったら end を送る。

    ■「話し始めるまで」と「話し終わってから」を分けている理由
    人は呼びかけたあと少し考える。両方を同じ 1.2 秒で測ると、
    「えーと」の間に打ち切られ、本題が一切録れない。
    実測でこれが起き、4回とも 1.3 秒（＝沈黙のみ）で終了していた。
    """
    start = time.time()
    speech_start: float | None = None   # None のうちはまだ話し始めていない
    silent_since: float | None = None
    recent: deque[float] = deque(maxlen=TRAIL_FRAMES)
    peak = 0.0

    while True:
        data = mic.stdout.read(FRAME * 2)
        if not data:
            raise ConnectionError("マイクが停止しました")

        session.ws.send_binary(data)

        now = time.time()
        level = rms(data)
        recent.append(level)
        peak = max(peak, level)
        loud = level >= silence_rms

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
                report_end("silence", now - speech_start, silence_rms, recent)
                return "silence"

        if speech_start is None:
            if now - start >= SPEECH_START_SEC:
                # 呼びかけただけで何も話さなかった場合。
                # サーバーは音声認識もLLMも呼ばずに済む
                session.send({"type": "end", "reason": "no_speech"})
                report_end("no_speech", 0.0, silence_rms, recent, peak)
                return "no_speech"
        elif now - speech_start >= UTTERANCE_MAX_SEC:
            session.send({"type": "end", "reason": "timeout"})
            report_end("timeout", now - speech_start, silence_rms, recent)
            return "timeout"


def stream_started_utterance(
    session: Session,
    mic,
    silence_rms: float,
    initial_frames: list[bytes],
) -> str:
    """ローカルで発話を検出した後の音声を、語頭のプリロール付きで送る。"""
    session.send({"type": "speech_start"})
    for data in initial_frames:
        session.ws.send_binary(data)

    speech_start = time.time()
    silent_since: float | None = None
    recent: deque[float] = deque(maxlen=TRAIL_FRAMES)
    while True:
        data = mic.stdout.read(FRAME * 2)
        if not data:
            raise ConnectionError("マイクが停止しました")
        session.ws.send_binary(data)

        now = time.time()
        level = rms(data)
        recent.append(level)
        if level >= silence_rms:
            silent_since = None
        elif silent_since is None:
            silent_since = now
        elif now - silent_since >= SILENCE_SEC:
            session.send({"type": "end", "reason": "silence"})
            report_end("silence", now - speech_start, silence_rms, recent)
            return "silence"

        if now - speech_start >= UTTERANCE_MAX_SEC:
            session.send({"type": "end", "reason": "timeout"})
            report_end("timeout", now - speech_start, silence_rms, recent)
            return "timeout"


def answer_location(session: Session, message: dict) -> None:
    """サーバーからの位置情報要求に答える。

    測位できていなくても必ず返す。無応答だとサーバーが数秒待たされ、
    その間ユーザーは黙ったままのAIを見つめることになる。
    """
    request_id = message.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        print("  [位置情報要求にrequestIdがありません]")
        return

    def fail(code: str, text: str) -> None:
        session.send({
            "type": "location_error",
            "requestId": request_id,
            "code": code,
            "message": text,
        })
        print(f"  [位置情報] {code}: {text}")

    if GPS is None:
        fail("NO_DEVICE", "GPSを使わない設定で起動しています")
        return

    try:
        fix = GPS.get_fix()
    except GPSUnavailable as e:
        fail(e.code, str(e))
        return

    # accuracy は GGA が使えないと出せない。任意項目なので入れずに送る
    payload = {
        "type": "location_result",
        "requestId": request_id,
        "lat": fix.lat,
        "lng": fix.lng,
        "measuredAt": fix.measured_at_iso(),
    }
    if fix.accuracy is not None:
        payload["accuracy"] = fix.accuracy
    session.send(payload)

    detail = f"{fix.lat:.5f}, {fix.lng:.5f}"
    if fix.accuracy is not None:
        detail += f" ±{fix.accuracy:.0f}m"
    if fix.satellites is not None:
        detail += f"（衛星{fix.satellites}個）"
    print(f"  [位置情報] {detail} を返しました（{fix.source}）")


def handle_server_message(session: Session, message: dict) -> str | None:
    """音声区間の内外を問わず届く制御メッセージを処理する。"""
    kind = message.get("type")
    if kind == "transcript":
        mark = "" if message.get("final") else "…"
        print(f"  あなた: {message.get('text', '')}{mark}")
    elif kind == "reply":
        print(f"  パッセン: {message.get('text', '')}")
        place = message.get("suggestedPlace")
        if place:
            print(f"  （提案: {place.get('name')}）")
    elif kind == "location_request":
        answer_location(session, message)
    elif kind == "listen":
        return "listen"
    elif kind == "conversation_ended":
        print(f"  [会話終了: {message.get('reason', 'unknown')}]")
        return "conversation_ended"
    elif kind == "error":
        print(f"  [エラー {message.get('code')}] {message.get('message')}")
        return "error"
    elif kind == "audio_start":
        return "audio_start"
    elif kind == "audio_end":
        return "audio_end"
    elif kind == "pong":
        return None
    else:
        print(f"  [未知のメッセージ: {kind}]")
    return None


def receive_audio(session: Session, fmt: dict) -> str:
    """audio_start を受けた後の音声を鳴らす。audio_end まで読み続ける。"""
    encoding = fmt.get("encoding", "pcm_s16le")

    if encoding == "wav":
        chunks: list[bytes] = []
        while True:
            opcode, data = session.ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_BINARY:
                chunks.append(data)
            elif opcode == websocket.ABNF.OPCODE_TEXT:
                action = handle_server_message(session, json.loads(data.decode()))
                if action in {"audio_end", "conversation_ended", "error"}:
                    if action != "audio_end":
                        return action
                    break
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("再生中に接続が切れました")

        path = os.path.join(tempfile.gettempdir(), "passen_reply.wav")
        with open(path, "wb") as f:
            f.write(amplify(b"".join(chunks), VOLUME))
        play_file(path)
        return "audio_end"

    rate = fmt.get("sampleRate", 24000)
    channels = fmt.get("channels", 1)
    player = open_raw_player(rate, channels)
    lead = bytearray()                                       # 鳴らす前に貯めておく音
    lead_bytes = int(rate * 2 * channels * PREBUFFER_SEC)     # 16bit なので1秒 = rate×2
    try:
        while True:
            opcode, data = session.ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_BINARY:
                lead += amplify(data, VOLUME)
                if len(lead) >= lead_bytes:
                    player.stdin.write(bytes(lead))
                    lead.clear()
                    lead_bytes = 0                            # 貯め終わったら以降は素通し
            elif opcode == websocket.ABNF.OPCODE_TEXT:
                action = handle_server_message(session, json.loads(data.decode()))
                if action in {"audio_end", "conversation_ended", "error"}:
                    return action
            elif opcode == websocket.ABNF.OPCODE_CLOSE:
                raise ConnectionError("再生中に接続が切れました")
    finally:
        # 貯めたまま終わる短い返事もあるので、残りを出し切ってから閉じる
        if lead and player.stdin:
            player.stdin.write(bytes(lead))
        # 閉じてから待つ。閉じないと aplay が入力の終わりに気づかず止まらない
        if player.stdin:
            player.stdin.close()
        player.wait()


def receive_model_turn(session: Session) -> tuple[str, dict]:
    """Geminiの返答を処理し、次の発話待ちか会話終了まで読む。"""
    while True:
        message = session.recv_json()
        action = handle_server_message(session, message)
        if action == "audio_start":
            action = receive_audio(session, message)
        if action == "listen":
            return action, message
        if action in {"conversation_ended", "error"}:
            return action, message


def wait_for_followup(
    session: Session,
    mic,
    silence_rms: float,
    timeout_seconds: float,
) -> str:
    """音声を外へ出さずに次の発話を待ち、検出後だけ同じ会話へ送る。"""
    timeout_seconds = max(1.0, min(timeout_seconds, 3600.0))
    # サーバーのアイドルタイマーより先に no_speech を届けるため、少し手前で切る。
    local_timeout = max(0.5, timeout_seconds - 0.25)
    started_at = time.monotonic()
    pre_roll: deque[bytes] = deque(maxlen=FOLLOWUP_PREROLL_FRAMES)
    print("  続けてどうぞ")

    while time.monotonic() - started_at < local_timeout:
        while True:
            message = session.recv_json_nowait()
            if message is None:
                break
            action = handle_server_message(session, message)
            if action in {"conversation_ended", "error"}:
                return action

        data = mic.stdout.read(FRAME * 2)
        if not data:
            raise ConnectionError("マイクが停止しました")
        pre_roll.append(data)
        if rms(data) >= silence_rms:
            return stream_started_utterance(
                session,
                mic,
                silence_rms,
                list(pre_roll),
            )
        session.maybe_ping()

    session.send({"type": "end", "reason": "no_speech"})
    return "no_speech"


def handle_conversation(session: Session, mic, silence_rms: float) -> None:
    """初回発話から、複数ターンの会話が終了するまでを処理する。"""
    stream_utterance(session, mic, silence_rms)

    while True:
        action, message = receive_model_turn(session)
        if action != "listen":
            return

        drain(mic.stdout)
        time.sleep(COOLDOWN_SEC)
        drain(mic.stdout)
        timeout = message.get("timeoutSeconds", SPEECH_START_SEC)
        if not isinstance(timeout, (int, float)):
            timeout = SPEECH_START_SEC
        outcome = wait_for_followup(session, mic, silence_rms, float(timeout))
        if outcome in {"conversation_ended", "error"}:
            return


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
        ambient: deque[float] = deque(maxlen=AMBIENT_FRAMES)

        while True:
            data = mic.stdout.read(FRAME * 2)
            if not data:
                raise ConnectionError("マイクが停止しました")

            ambient.append(rms(data))
            scores = wake.predict(np.frombuffer(data, dtype=np.int16))
            score = max(scores.values())

            while True:
                message = session.recv_json_nowait()
                if message is None:
                    break
                handle_server_message(session, message)

            if score <= THRESHOLD:
                session.maybe_ping()
                continue

            # 呼びかけの直前数秒の音から、無音の基準を決め直す。起動後に車内の音が
            # 変わっても追従させるため。人の声が混じっても引っぱられないよう、
            # 静かな方から4分の1の位置を暗騒音とみなす（呼びかけ自体の約1秒も効かない）
            if len(ambient) >= AMBIENT_FRAMES // 2:
                silence_rms = threshold_from(list(ambient), quantile=0.25)
            print(f"[検出 {score:.2f}] どうぞ（無音の基準 {silence_rms:.0f}）")
            session.send({
                "type": "wake",
                "score": round(float(score), 3),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            play_file(BEEP)
            drain(mic.stdout)   # ビープ音を発話として送らないため

            handle_conversation(session, mic, silence_rms)

            drain(mic.stdout)
            wake.reset()
            time.sleep(COOLDOWN_SEC)
            drain(mic.stdout)
            wake.reset()
            ambient.clear()   # 会話の前の音は古いので捨てる
            print()
    finally:
        mic.terminate()
        ws.close()


def main() -> None:
    global GPS

    print("モデルを読み込んでいます…")
    wake = WakeModel(wakeword_model_paths=[WAKE_MODEL])
    print(f"マイク: card {MIC_CARD} / スピーカー: card {SPK_CARD}")
    if VOLUME != 1.0:
        print(f"再生音量: ×{VOLUME:g}")

    if USE_GPS:
        # WebSocket 接続より先に測位を始める。GPS の初回測位には時間が
        # かかるため、場所登録を頼まれた時点で最新座標を返せるようにする。
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
