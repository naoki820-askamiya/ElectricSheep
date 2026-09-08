"""補正モデルを併用したウェイクワード検出。

wake_oww.py との違いは custom_verifier を渡している点だけ。
自分の声に合わせた判定が加わるため、反応と誤検出の両方が改善する。
"""
import re
import subprocess
import sys

import numpy as np
from openwakeword.model import Model

SAMPLE_RATE = 16000
FRAME = 1280
THRESHOLD = 0.35
VERIFIER_THRESHOLD = 0.3  # 補正側の判定。厳しくするなら上げる

MODEL = "passen.onnx"
VERIFIER = "passen_verifier.pkl"


def find_card() -> str:
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


model = Model(
    wakeword_model_paths=[MODEL],
    custom_verifier_models={"passen": VERIFIER},
    custom_verifier_threshold=VERIFIER_THRESHOLD,
)

print("検出できる語:", ", ".join(model.models.keys()))
card = find_card()
proc = subprocess.Popen(
    ["arecord", "-q", "-D", f"plughw:{card},0",
     "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE), "-t", "raw"],
    stdout=subprocess.PIPE,
)

print(f"マイク: card {card}  判定: {THRESHOLD} / 補正: {VERIFIER_THRESHOLD}")
print("\n「パッセン」と話しかけてください（Ctrl+C で終了）\n")

count = 0
peak = 0.0
try:
    while True:
        data = proc.stdout.read(FRAME * 2)
        if not data:
            break
        scores = model.predict(np.frombuffer(data, dtype=np.int16))
        for name, score in scores.items():
            peak = max(peak, float(score))
            if score > THRESHOLD:
                count += 1
                print(f"検出: {name}  （確信度 {score:.2f}／{count}回目）")
except KeyboardInterrupt:
    print(f"\n最高スコア: {peak:.2f}／検出回数: {count}")
finally:
    proc.terminate()
