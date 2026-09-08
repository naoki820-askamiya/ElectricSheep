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
