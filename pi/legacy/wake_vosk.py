"""語彙を絞ったウェイクワード検出。

汎用の音声認識は数万語から選ぶため、辞書に無い造語は毎回違う結果になる。
候補を数語に限定すると、その中から選ぶだけになり精度が大きく上がる。

指定した語がモデルの辞書に無いと機能しないので、
似た音の候補をまとめて登録し、どれに反応するかを実機で確かめる。
"""
import json
import re
import subprocess

from vosk import Model, KaldiRecognizer

SAMPLE_RATE = 16000

# 「パッセン」に近い音の候補。実機で反応したものを後で絞り込む。
# [unk] は「候補以外の音」を受け止める枠。これが無いと何でも候補に寄せてしまう。
CANDIDATES = [
    "ぱっせん", "ぱつせん", "はっせん", "ばっせん",
    "ぱーせん", "ぱっせ", "せん",
    "[unk]",
]


def find_card() -> str:
    out = subprocess.run(["arecord", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"card (\d+):.*(Microphone|USB)", line)
        if m:
            return m.group(1)
    raise SystemExit("マイクが見つかりません")


card = find_card()
model = Model("vosk-model-small-ja-0.22")

# 第3引数に候補を渡すと、その語彙だけで認識するようになる
grammar = json.dumps(CANDIDATES, ensure_ascii=False)
recognizer = KaldiRecognizer(model, SAMPLE_RATE, grammar)

proc = subprocess.Popen(
    ["arecord", "-q", "-D", f"plughw:{card},0",
     "-f", "S16_LE", "-c", "1", "-r", str(SAMPLE_RATE), "-t", "raw"],
    stdout=subprocess.PIPE,
)

print(f"マイク: card {card}")
print(f"候補: {', '.join(c for c in CANDIDATES if c != '[unk]')}")
print("\n「パッセン」と10回ほど言ってみてください（Ctrl+C で終了）\n")

hits: dict[str, int] = {}
try:
    while True:
        data = proc.stdout.read(4000)
        if not data:
            break
        if recognizer.AcceptWaveform(data):
            text = json.loads(recognizer.Result())["text"].replace(" ", "")
            if text:
                hits[text] = hits.get(text, 0) + 1
                print(f"認識: {text}")
except KeyboardInterrupt:
    print("\n--- 集計 ---")
    for word, n in sorted(hits.items(), key=lambda x: -x[1]):
        print(f"  {word}: {n}回")
    print("\n最も多く出た語をウェイクワードに採用します")
finally:
    proc.terminate()
