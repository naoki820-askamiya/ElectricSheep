"""ウェイクワード検出の確認用。

汎用の音声認識（Vosk）で造語を拾うのは苦手なので、
1語の検出に特化した Porcupine を使う。軽く、精度が高い。

使い方:
    ./venv/bin/python wake.py                 # 内蔵キーワードで動作確認
    ./venv/bin/python wake.py passen_ja.ppn   # 自作の「パッセン」で検出
"""
import os
import struct
import sys

import pvporcupine
from pvrecorder import PvRecorder

# アクセスキーは環境変数か access_key.txt から読む。
# コードに直接書くとGitHubに載る危険があるため。
ACCESS_KEY = os.environ.get("PICOVOICE_ACCESS_KEY", "").strip()
if not ACCESS_KEY and os.path.exists("access_key.txt"):
    ACCESS_KEY = open("access_key.txt", encoding="utf-8").read().strip()
if not ACCESS_KEY:
    raise SystemExit(
        "アクセスキーがありません。\n"
        "  echo 'あなたのキー' > ~/passen/access_key.txt"
    )


def find_mic() -> int:
    """USBマイクを名前で探す。番号は挿し直すたびに変わるため"""
    devices = PvRecorder.get_available_devices()
    for i, name in enumerate(devices):
        print(f"  [{i}] {name}")
        if "USB" in name or "Microphone" in name:
            return i
    return -1  # 見つからなければ既定のデバイス


custom = sys.argv[1] if len(sys.argv) > 1 else None

if custom:
    # 日本語のキーワードには日本語用のモデルファイルが必要
    porcupine = pvporcupine.create(
        access_key=ACCESS_KEY,
        keyword_paths=[custom],
        model_path="porcupine_params_ja.pv",
    )
    label = os.path.basename(custom)
else:
    # まずは内蔵キーワードで配線が正しいかを確かめる
    porcupine = pvporcupine.create(access_key=ACCESS_KEY, keywords=["computer"])
    label = "computer（内蔵・英語）"

print("マイク一覧:")
mic_index = find_mic()
print(f"使用するマイク: [{mic_index}]")

recorder = PvRecorder(frame_length=porcupine.frame_length, device_index=mic_index)
recorder.start()

print(f"\n『{label}』と話しかけてください（Ctrl+C で終了）")

count = 0
try:
    while True:
        pcm = recorder.read()
        if porcupine.process(pcm) >= 0:
            count += 1
            print(f"検出しました（{count}回目）")
except KeyboardInterrupt:
    print(f"\n終了します。検出回数: {count}")
finally:
    recorder.stop()
    recorder.delete()
    porcupine.delete()
