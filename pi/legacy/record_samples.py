"""補正用の音声を録音する。

自作モデルは英語の音声合成で学習しているため、日本語話者の発音では
反応が鈍いことがある。自分の声を数回録音して追加学習させると、
その発音に合わせて判定が調整される。

使い方:
    ./venv/bin/python record_samples.py positive 10   # 「パッセン」を10回
    ./venv/bin/python record_samples.py negative 10   # 別の言葉を10回
"""
import os
import re
import subprocess
import sys
import time

SAMPLE_RATE = 16000
DURATION = 2  # 1回あたりの録音秒数


def find_card() -> str:
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


kind = sys.argv[1] if len(sys.argv) > 1 else "positive"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
if kind not in ("positive", "negative"):
    raise SystemExit("positive か negative を指定してください")

out_dir = os.path.join("samples", kind)
os.makedirs(out_dir, exist_ok=True)
card = find_card()

what = "「パッセン」" if kind == "positive" else "『パッセン』以外の言葉"
print(f"{what} を {count} 回録音します。")
print("1回ごとに2秒間録音します。合図のあとすぐ話してください。\n")

start = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
for i in range(count):
    path = os.path.join(out_dir, f"{start + i:03d}.wav")
    for n in (3, 2, 1):
        print(f"  {n}...", end="\r", flush=True)
        time.sleep(0.6)
    print("  ● 録音中   ", end="\r", flush=True)
    subprocess.run(
        ["arecord", "-q", "-D", f"plughw:{card},0",
         "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE),
         "-d", str(DURATION), path],
        check=True,
    )
    print(f"  [{i + 1}/{count}] 保存: {path}")
    time.sleep(0.3)

total = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
print(f"\n完了。{out_dir} に {total} 件あります。")
