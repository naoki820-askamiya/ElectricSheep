# 車載デバイス（Raspberry Pi）

「パッセン」の車載側です。ユーザーの呼びかけを検出し、声をサーバーへ送り、返事を鳴らします。

担当: ゆうすけ
サーバーとのやり取りの仕様: [../docs/websocket-protocol.md](../docs/websocket-protocol.md)

---

## 今できていること

| | 状態 |
|---|---|
| ウェイクワード検出「パッセンジャー」 | **動く**（実測 最高スコア 0.99） |
| マイク録音・スピーカー再生 | **動く** |
| WebSocket でサーバーと通信 | **実装済み。スタブで検証済み** |
| 音声認識・LLM・音声合成 | **サーバー側。未実装** |

サーバーがまだ無いので、`ws_stub.js`（返事の代わりに音階を鳴らすだけの偽サーバー）で
Pi 側だけ先に確かめられるようにしてあります。

---

## ハードウェア構成

| | |
|---|---|
| 本体 | Raspberry Pi 4 (2GB) |
| OS | Raspberry Pi OS **Lite** 64-bit（Debian 12 Bookworm ベース） |
| マイク | USB接続（C-Media）→ `plughw:3,0` |
| スピーカー | USB接続（Jieli）→ `plughw:4,0` |
| 画面 | **無し。** SSH で操作する |

OS を Lite にしているのは、画面を使わない設計だからです。デスクトップ環境の分だけ
メモリと起動時間が浮きます。

**card 番号は挿す順で変わります。** スクリプトは `arecord -l` / `aplay -l` から
自動で探すので、通常は指定不要です。ずれたら環境変数で上書きしてください。

---

## セットアップ

Pi に SSH で入ってから。

```bash
sudo apt update && sudo apt install -y python3-venv alsa-utils
mkdir -p ~/passen && cd ~/passen
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

このフォルダのファイルと `passenger.onnx` を `~/passen/` に置きます。
モデルの入手は [models/README.md](models/README.md) を見てください。

### 動作確認

```bash
# マイク（5秒録って再生する）
arecord -D plughw:3,0 -d 5 -f cd /tmp/t.wav && aplay -D plughw:4,0 /tmp/t.wav

# ウェイクワードだけ
./venv/bin/python wake_oww.py passenger.onnx
```

---

## ファイル

| | |
|---|---|
| `passen_ws.py` | **本体。** ウェイクワード → 音声送信 → 返事の再生 |
| `wake_oww.py` | ウェイクワード単体の確認。スコアを見て閾値を決めるのに使う |
| `passen_agent.py` | WebSocket を使わない版。Pi 内で音声認識まで行う（要 Vosk モデル） |
| `ws_stub.js` | 検証用の偽サーバー。**本番では使わない** |
| `legacy/` | 試したが採用しなかったもの。経緯として残してある |

---

## 動かす

### サーバーができるまで（スタブ相手）

PC 側でスタブを起動します。初回だけ `npm install` が要ります。

```bash
npm install   # 初回のみ
node ws_stub.js
```

Pi 側から繋ぎます。IP は PC のものです。

```bash
cd ~/passen
PASSEN_WS=ws://192.168.1.10:8080/ws ./venv/bin/python passen_ws.py
```

「パッセンジャー」と呼ぶと**ピッと鳴ります。** 続けて話すと、無音が1.2秒続いた時点で
送信が終わり、返事の代わりに音階が鳴ります。

送った音声は PC 側の `recv/` に WAV で溜まります。**再生して声が入っているか
確かめてください。** ここが濁っているとサーバー側で何をしても認識精度は出ません。

### 本番サーバーに繋ぐ

URL を差し替えるだけです。

```bash
PASSEN_WS=ws://<サーバー>/ws ./venv/bin/python passen_ws.py
```

---

## 環境変数

| | 既定 | |
|---|---|---|
| `PASSEN_WS` | `ws://localhost:8080/ws` | 接続先 |
| `PASSEN_WAKE` | `passenger.onnx` | ウェイクワードのモデル |
| `PASSEN_USER` | `pi-demo` | ユーザーID |
| `PASSEN_MIC` | 自動検出 | マイクの card 番号 |
| `PASSEN_SPK` | 自動検出 | スピーカーの card 番号 |

---

## 設計の決めごと

**待ち受け中、マイクの音は Pi の外に出ません。**
ウェイクワード検出は Pi の中だけで完結します。常時ストリーミングは通信量の無駄であり、
プライバシー上も説明しづらいためです。

**再生中はマイクの入力を捨てます。**
自分の声で再検出するのを防ぎます。「AIが喋っている最中に遮る」ことができなくなる
代わりに、エコーキャンセル付きの高価なデバイスが要らなくなります。

**マイクは1本の `arecord` を使い回します。**
開き直すと ALSA が数百ミリ秒止まり、その間の発話が丸ごと落ちるためです。

**発話の終わりは Pi が判定します。**
音量（RMS）が閾値を下回る状態が1.2秒続いたら送信を打ち切ります。
車内は暗騒音があるので、実車で調整が要ります（`SILENCE_RMS`）。

---

## 調整が要りそうな数値

`passen_ws.py` の先頭にまとめてあります。

| | 既定 | 効き方 |
|---|---|---|
| `THRESHOLD` | 0.35 | ウェイクワードの判定。誤検出が増えたら上げる |
| `SILENCE_RMS` | 400 | 無音とみなす音量。車内では上げる必要があるかも |
| `SILENCE_SEC` | 1.2 | 何秒黙ったら発話終了とみなすか |
| `UTTERANCE_MAX_SEC` | 10.0 | 1回の発話の上限 |

---

## 採用しなかったもの（`legacy/`）

| | 理由 |
|---|---|
| `wake.py` (Picovoice Porcupine) | **無料枠が2026年6月30日で終了。** 個人では使えない |
| `wake_vosk.py` | Vosk で単語を待ち受ける方式。誤検出が多く実用にならなかった |
| `listen.py` | Vosk の動作確認用。`passen_agent.py` に取り込み済み |
| `record_samples.py` / `train_verifier.py` / `wake_verified.py` | 自分の声でモデルを補正する試み。**元モデルが反応せず断念。** 語を `passenger` に変えたら不要になった |

---

## 未着手

- **返事の読み上げ。** 現状は音声合成がサーバー側にも無い
- **停止スイッチ。** 物理的にマイクを切る手段が要る（プライバシー要件）
- **自動起動。** 今は SSH で手動起動。systemd に登録する
- **位置情報。** README の設計ではスマートフォンが担当。Pi からは送っていない
