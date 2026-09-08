"""録音した自分の声で補正モデルを作る。

自作モデルは英語の音声合成で学習しているため、日本語話者の発音では
判定が鈍い。ここで作る補正モデルを併用すると、
「この声のこの発音」に限って判定が調整される。
"""
import glob
import os

import openwakeword
from openwakeword.custom_verifier_model import train_custom_verifier

POS = sorted(glob.glob("samples/positive/*.wav"))
NEG = sorted(glob.glob("samples/negative/*.wav"))
MODEL = "passen.onnx"
OUT = "passen_verifier.pkl"

if len(POS) < 5:
    raise SystemExit(f"positive が {len(POS)} 件しかありません。10件以上を推奨します")
if len(NEG) < 5:
    raise SystemExit(f"negative が {len(NEG)} 件しかありません。10件以上を推奨します")
if not os.path.exists(MODEL):
    raise SystemExit(f"{MODEL} が見つかりません")

print(f"positive: {len(POS)}件 / negative: {len(NEG)}件")
print("学習中...")

train_custom_verifier(
    positive_reference_clips=POS,
    negative_reference_clips=NEG,
    output_path=OUT,
    model_name=MODEL,
)

print(f"\n完了: {OUT} ({os.path.getsize(OUT)} バイト)")
print("次はこれで試してください:")
print("  ./venv/bin/python wake_verified.py")
