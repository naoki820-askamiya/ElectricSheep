"""openWakeWord によるウェイクワード検出。

汎用の音声認識と違い「特定の1語が鳴ったか」だけを判定するため、
軽くて誤検出が少ない。常時待ち受けに向く。

使い方:
    ./venv/bin/python wake_oww.py                # 同梱モデルを全部
    ./venv/bin/python wake_oww.py hey_jarvis     # 名前で1つ選ぶ
    ./venv/bin/python wake_oww.py my_word.onnx   # 自作モデルを指定
"""
import os
import re
import subprocess
import sys

import numpy as np
import openwakeword
from openwakeword.model import Model

SAMPLE_RATE = 16000
FRAME = 1280      # openWakeWord が想定する1回分の長さ（80ms）
THRESHOLD = 0.35   # これを超えたら検出とみなす。誤検出が多ければ上げる


def find_card() -> str:
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


def resolve_models(arg: str | None) -> list[str]:
    """このバージョンはモデルを『ファイルのパス』で受け取る。
    名前だけ渡されたら、同梱モデルの中から探して絶対パスに直す。"""
    bundled = openwakeword.get_pretrained_model_paths()
    if not arg:
        return bundled
    if arg.endswith(".onnx") and os.path.exists(arg):
        return [arg]
    for path in bundled:
        if arg in os.path.basename(path):
            return [path]
    raise SystemExit(
        f"'{arg}' が見つかりません。使えるもの:\n  "
        + "\n  ".join(os.path.basename(p) for p in bundled)
    )


paths = resolve_models(sys.argv[1] if len(sys.argv) > 1 else None)
model = Model(wakeword_model_paths=paths)

print("検出できる語:", ", ".join(model.models.keys()))

card = find_card()
proc = subprocess.Popen(
    ["arecord", "-q", "-D", f"plughw:{card},0",
     "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE), "-t", "raw"],
    stdout=subprocess.PIPE,
)

print(f"マイク: card {card}")
print("\n話しかけてください（Ctrl+C で終了）\n")

count = 0
peak: dict[str, float] = {}
try:
    while True:
        data = proc.stdout.read(FRAME * 2)   # 16bit なので1サンプル2バイト
        if not data:
            break
        audio = np.frombuffer(data, dtype=np.int16)
        scores = model.predict(audio)

        for name, score in scores.items():
            peak[name] = max(peak.get(name, 0.0), float(score))
            if score > THRESHOLD:
                count += 1
                print(f"検出: {name}  （確信度 {score:.2f}／{count}回目）")
except KeyboardInterrupt:
    print("\n--- 各語の最高スコア ---")
    for name, score in sorted(peak.items(), key=lambda x: -x[1]):
        print(f"  {name}: {score:.2f}")
    print(f"\n検出回数: {count}")
finally:
    proc.terminate()
