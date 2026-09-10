# ウェイクワードのモデル

`passenger.onnx` をこのフォルダに置いてください。

Google Colab の openWakeWord 学習ノートブックで作ったもので、
**「パッセンジャー」という呼びかけだけを検出**します。約1.5MBです。

Pi 実機での実測（2026-09-08）:

```
最高スコア 0.99 / 7回の呼びかけすべてで検出
```

## 置き場所について

`passen_ws.py` は既定で `passenger.onnx` を見ます。models/ に置く場合は
環境変数で渡してください。

```bash
PASSEN_WAKE=models/passenger.onnx ./venv/bin/python passen_ws.py
```

## 作り直したい場合

openWakeWord の学習ノートブックで、対象の語だけ変えれば作れます。
2026年9月時点では、そのままでは動かないので以下の対処が要ります。

1. `piper-phonemize-cross` → `piper-phonemize-fix` に置き換える
2. ランタイムを GPU (T4) にする
3. `pip install -e /content/openwakeword --no-deps`（依存の speexdsp-ns が入らないため）
4. `pip install deep-phonemizer`
5. `data.py` の `torch.load` に `weights_only=False` を足す

**日本語の語をそのまま指定しても学習できません。** 音声合成が英語基準のため、
ローマ字で綴る必要があります。造語（`passen`）はスコアが出ず失敗しました。
**実在の英単語（`passenger`）にしたら一発で通りました。**

---

## 日本語発音への対応（2026-09-09 実測）

`passenger` だけで学習したモデルは、**英語寄りの発音にしか反応しませんでした。**
日本語で「パッセンジャー」と言っても検出できません。

学習データを作るのが英語の音声合成なので、当然といえば当然です。

### 解決した方法

綴りを複数与えて、日本語に近い読み方もさせました。

```python
TARGET_PHRASE = [
    'passenger',      # 英語寄りの発音も残す
    'passenjaa',      # パッセンジャー（語尾を伸ばす）
    'pahssenjah',     # 「パ」を深く
    'pas sen jaa',    # モーラを区切って読ませる
    'passenjar',
]
MODEL_NAME = 'passenjaa'
```

日本語の発音は英語と3点違います。**促音（っ）・撥音（ん）・語尾の伸ばし**です。
それぞれ `ss` の強調、`sen` の切り出し、`aa` で表現しています。

### 結果

Pi 実機で、2つのモデルを同時に載せて比較しました。

```
日本語「パッセンジャー」×5
  passenjaa   5/5 検出   最高 1.00
  passenger   0/5        最高 0.15

英語風「パセンジャー」×5
  passenjaa   5/5 検出   最高 1.00
  passenger   3/5        最高 1.00
```

`passenger` が反応した回は**すべて `passenjaa` も同時に反応**しました。
つまり `passenjaa` は `passenger` の上位互換で、**1つだけ載せれば足ります。**

### 閾値の根拠

日本語5回のスコアは `0.98 / 0.86 / 0.94 / 0.41 / 0.88` でした。

**最低が 0.41 なので、閾値 0.5 では取りこぼします。** 0.35 のままにしてください。
誤検出が多くて上げる場合でも、0.4 が上限です。

### 使い方

コードを変えずに環境変数で切り替えられます。

```bash
PASSEN_WAKE=passenjaa.onnx ./venv/bin/python passen_ws.py
```

### 教訓

**造語（`passen`）は失敗しました。** 音声合成が安定した音を作れず、
自分の声で補正しようとしても、元モデルが反応しないため学習データが集まりませんでした。

**実在する英単語を選び、綴りを変えて発音のばらつきを作る。** これが正解でした。
