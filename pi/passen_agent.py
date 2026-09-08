"""パッセン本体。ウェイクワードで起き、話を聞き、返事を受け取る。

    ./venv/bin/python passen_agent.py

対話サーバーに繋ぐ場合は URL を渡す（省略時は聞き取り結果を表示するだけ）:
    PASSEN_API=http://192.168.1.10:3000/api/chat ./venv/bin/python passen_agent.py

■ 録音を1本の arecord で共有している理由
マイクを開き直すと ALSA が数百ms 止まり、その間の発話が丸ごと落ちる。
1本の流れを、検出中は openWakeWord に、聞き取り中は Vosk に渡し分けている。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from openwakeword.model import Model as WakeModel
from vosk import KaldiRecognizer, Model as VoskModel

SAMPLE_RATE = 16000
FRAME = 1280          # openWakeWord が想定する1回分（80ms）
THRESHOLD = 0.35       # 誤検出が多ければ上げる

# 検出直後の待ち時間。これが無いと1回の発話が何度も検出される
COOLDOWN_SEC = 2.0

LISTEN_MAX_SEC = 8.0  # 聞き取りの上限。黙っていてもここで打ち切る

WAKE_MODEL = os.environ.get("PASSEN_WAKE", "passenger.onnx")
VOSK_DIR = os.environ.get("PASSEN_VOSK", "vosk-model-small-ja-0.22")
API_URL = os.environ.get("PASSEN_API")
USER_ID = os.environ.get("PASSEN_USER", "pi-demo")


def find_card(cmd: str, skip: str) -> str:
    """arecord -l / aplay -l から USB 機器の card 番号を拾う。
    Pi 内蔵の HDMI・イヤホン端子は skip で除外する。"""
    out = subprocess.run([cmd, "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):", line)
        if m and not re.search(skip, line, re.I):
            return m.group(1)
    raise SystemExit(f"{cmd} で機器が見つかりません")


MIC_CARD = os.environ.get("PASSEN_MIC") or find_card("arecord", r"vc4hdmi|bcm2835")
SPK_CARD = os.environ.get("PASSEN_SPK") or find_card(
    "aplay", r"Headphones|vc4hdmi|bcm2835"
)

BEEP_PATH = "/tmp/passen_beep.wav"


def make_beep() -> None:
    """返事を待っていることを音で知らせる。画面を見ない前提なので必須。"""
    import wave

    t = np.linspace(0, 0.12, int(SAMPLE_RATE * 0.12), endpoint=False)
    tone = (np.sin(2 * np.pi * 880 * t) * 0.3 * 32767).astype(np.int16)
    with wave.open(BEEP_PATH, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        f.writeframes(tone.tobytes())


def beep() -> None:
    subprocess.run(
        ["aplay", "-q", "-D", f"plughw:{SPK_CARD},0", BEEP_PATH],
        stderr=subprocess.DEVNULL,
    )


def listen(stream, rec) -> str:
    """発話が終わるまで聞き取る。Vosk は文の切れ目で True を返す。"""
    rec.Reset()
    start = time.time()
    while time.time() - start < LISTEN_MAX_SEC:
        data = stream.read(FRAME * 2)
        if not data:
            break
        if rec.AcceptWaveform(data):
            text = json.loads(rec.Result()).get("text", "")
            if text.strip():
                return text.replace(" ", "")  # Vosk は形態素ごとに空白を入れる
    return json.loads(rec.FinalResult()).get("text", "").replace(" ", "")


def ask(text: str) -> str | None:
    """対話サーバーに投げる。繋がらなくても待ち受けは止めない。"""
    if not API_URL:
        return None
    body = json.dumps({"userId": USER_ID, "message": text}).encode()
    req = urllib.request.Request(
        API_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read()).get("reply")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print(f"  [対話サーバーに繋がりません: {e}]")
        return None


print("モデルを読み込んでいます…")
wake = WakeModel(wakeword_model_paths=[WAKE_MODEL])
vosk = VoskModel(VOSK_DIR)
rec = KaldiRecognizer(vosk, SAMPLE_RATE)
make_beep()

proc = subprocess.Popen(
    ["arecord", "-q", "-D", f"plughw:{MIC_CARD},0",
     "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE), "-t", "raw"],
    stdout=subprocess.PIPE,
)

print(f"マイク: card {MIC_CARD} / スピーカー: card {SPK_CARD}")
print(f"接続先: {API_URL or '未設定（聞き取り結果を表示するだけ）'}")
print("\n「パッセンジャー」と呼びかけてください（Ctrl+C で終了）\n")

try:
    while True:
        data = proc.stdout.read(FRAME * 2)
        if not data:
            break
        scores = wake.predict(np.frombuffer(data, dtype=np.int16))

        if max(scores.values()) <= THRESHOLD:
            continue

        print(f"[検出 {max(scores.values()):.2f}] どうぞ")
        beep()

        text = listen(proc.stdout, rec)
        if not text:
            print("  （聞き取れませんでした）\n")
        else:
            print(f"  あなた: {text}")
            reply = ask(text)
            if reply:
                print(f"  パッセン: {reply}")
            print()

        # 自分の声や返事で再検出しないよう、判定を寝かせてから戻る
        wake.reset()
        time.sleep(COOLDOWN_SEC)
        wake.reset()
except KeyboardInterrupt:
    print("\n終了します")
finally:
    proc.terminate()
