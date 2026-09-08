"""マイクの音を文字にする確認用プログラム。

録音は arecord に任せ、16kHz モノラルへ変換させてから Vosk に渡す。
PortAudio で 44100Hz を直接扱うと、ラズパイでは処理が追いつかず
音を取りこぼす（input overflow）ため。
"""
import json
import re
import subprocess
from vosk import Model, KaldiRecognizer

SAMPLE_RATE = 16000  # Vosk が最も得意な周波数


def find_card() -> str:
    """arecord -l から USB マイクの card 番号を探す"""
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


card = find_card()
print(f"マイク: card {card} / {SAMPLE_RATE}Hz")

model = Model("vosk-model-small-ja-0.22")
recognizer = KaldiRecognizer(model, SAMPLE_RATE)

# plughw を使うと ALSA 側で周波数とチャンネル数を変換してくれる
proc = subprocess.Popen(
    [
        "arecord", "-q",
        "-D", f"plughw:{card},0",
        "-f", "S16_LE",
        "-c", "1",
        "-r", str(SAMPLE_RATE),
        "-t", "raw",
    ],
    stdout=subprocess.PIPE,
)

print("話しかけてください（Ctrl+C で終了）")

try:
    while True:
        data = proc.stdout.read(4000)
        if not data:
            break
        if recognizer.AcceptWaveform(data):
            text = json.loads(recognizer.Result())["text"].replace(" ", "")
            if text:
                print("確定:", text)
        else:
            partial = json.loads(recognizer.PartialResult())["partial"].replace(" ", "")
            if partial:
                print("認識中:", partial, end="\r")
except KeyboardInterrupt:
    print("\n終了します")
finally:
    proc.terminate()
