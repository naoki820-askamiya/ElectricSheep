"""openWakeWord によるウェイクワード検出。

汎用の音声認識と違い「特定の1語が鳴ったか」だけを判定するため、
軽くて誤検出が少ない。常時待ち受けに向く。

使い方:
    ./venv/bin/python wake_oww.py                # 同梱モデルを全部
    ./venv/bin/python wake_oww.py hey_jarvis     # 名前で1つ選ぶ
    ./venv/bin/python wake_oww.py my_word.onnx   # 自作モデルを指定
    ./venv/bin/python wake_oww.py a.onnx b.onnx  # 複数を同時に載せて比べる

複数指定すると、同じ発話に対する各モデルのスコアを並べて見られる。
発音の違う版を作ったとき、どちらがよく反応するかを数字で比較できる。
"""
import os
import re
import subprocess
import sys
import time

import numpy as np
import openwakeword
from openwakeword.model import Model

SAMPLE_RATE = 16000
FRAME = 1280      # openWakeWord が想定する1回分の長さ（80ms）
THRESHOLD = 0.35   # これを超えたら検出とみなす。誤検出が多ければ上げる

# 1回の発話は80msごとに何度も閾値を超える。これが無いと
# 「5回呼んで12回検出」のような数字になり、精度の比較ができない。
COOLDOWN_SEC = 1.5


def find_card() -> str:
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


def resolve_one(arg: str) -> str:
    """このバージョンはモデルを『ファイルのパス』で受け取る。
    名前だけ渡されたら、同梱モデルの中から探して絶対パスに直す。"""
    bundled = openwakeword.get_pretrained_model_paths()
    if arg.endswith(".onnx") and os.path.exists(arg):
        return arg
    for path in bundled:
        if arg in os.path.basename(path):
            return path
    raise SystemExit(
        f"'{arg}' が見つかりません。使えるもの:\n  "
        + "\n  ".join(os.path.basename(p) for p in bundled)
    )


def resolve_models(args: list[str]) -> list[str]:
    """引数なしなら同梱モデル全部。複数渡せば全部載せる。"""
    if not args:
        return openwakeword.get_pretrained_model_paths()
    return [resolve_one(a) for a in args]


paths = resolve_models(sys.argv[1:])
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

peak: dict[str, float] = {}
hits: dict[str, int] = {}
last_hit: dict[str, float] = {}
try:
    while True:
        data = proc.stdout.read(FRAME * 2)   # 16bit なので1サンプル2バイト
        if not data:
            break
        audio = np.frombuffer(data, dtype=np.int16)
        scores = model.predict(audio)
        now = time.time()

        # 1回の発話に対する各モデルのスコアを、同じ行に並べて出す。
        # モデルを比べるときは、この横並びが判断材料になる。
        fired = [n for n, s in scores.items()
                 if s > THRESHOLD and now - last_hit.get(n, 0.0) >= COOLDOWN_SEC]

        for name, score in scores.items():
            peak[name] = max(peak.get(name, 0.0), float(score))

        if fired:
            for name in fired:
                hits[name] = hits.get(name, 0) + 1
                last_hit[name] = now
            detail = "  ".join(f"{n}={scores[n]:.2f}" for n in sorted(scores))
            print(f"検出: {', '.join(fired)}   [{detail}]")
except KeyboardInterrupt:
    print("\n--- 結果 ---")
    for name, score in sorted(peak.items(), key=lambda x: -x[1]):
        print(f"  {name:<24} 最高 {score:.2f}   検出 {hits.get(name, 0)}回")
finally:
    proc.terminate()
