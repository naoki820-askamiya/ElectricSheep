# 車載デバイス（Raspberry Pi）

「パッセン」の車載側です。ユーザーの呼びかけを検出し、声をサーバーへ送り、返事を鳴らします。

担当: ゆうすけ
サーバーとのやり取りの仕様: [../docs/websocket-protocol.md](../docs/websocket-protocol.md)

---

## 今できていること

| | 状態 |
|---|---|
| ウェイクワード検出「パッセンジャー」 | **動く**（日本語発音で 5/5 検出。[models/README.md](models/README.md)） |
| マイク録音・スピーカー再生 | **動く** |
| WebSocket でサーバーと通信 | **実装済み。スタブと本番バックエンドで検証可能** |
| 音声認識・LLM・音声合成 | **Gemini Liveバックエンドへ接続済み** |
| 複数ターン会話 | **実装済み。初回だけウェイクワードが必要** |
| 位置情報 | **通信形式のみ実装済み。今日は取得失敗を即時応答** |

`ws_stub.js`（返事の代わりに音階を鳴らすだけの偽サーバー）を使うと、
GeminiやFirestoreなしでPi側だけを切り分けて確認できます。

---

## ハードウェア構成

| | |
|---|---|
| 本体 | Raspberry Pi 4 (2GB) |
| OS | Raspberry Pi OS **Lite** 64-bit（Debian 12 Bookworm ベース） |
| マイク | USB接続（USB Microphone） |
| スピーカー | USB接続（UACDemoV1.0） |
| GPS | USB接続（VK-162 / u-blox 7）→ `/dev/ttyACM0` |
| 画面 | **無し。** SSH で操作する |

OS を Lite にしているのは、画面を使わない設計だからです。デスクトップ環境の分だけ
メモリと起動時間が浮きます。

**card 番号は固定ではありません。** USB機器を増やすと入れ替わります。実際、GPSを
足したときにマイクとスピーカーが 3↔4 で入れ替わりました。番号を覚えないでください。

スクリプトは `arecord -l` / `aplay -l` から自動で探します。USBマイクは再生デバイスも
持っていることが多いため、**スピーカー側はマイク以外を選ぶ**ようにしてあります。
ずれたら環境変数で上書きできます。

```bash
arecord -l && aplay -l    # 今の割り当てを確認する
```

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
# マイク（5秒録って再生する。card番号は arecord -l / aplay -l で確認）
arecord -D plughw:4,0 -d 5 -f cd /tmp/t.wav && aplay -D plughw:3,0 /tmp/t.wav

# ウェイクワードだけ
./venv/bin/python wake_oww.py passenjaa.onnx

# 複数のモデルを比べる（スコアが横並びで出る）
./venv/bin/python wake_oww.py passenger.onnx passenjaa.onnx
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

リポジトリ直下で `npm run backend` を起動し、URLを差し替えます。

```bash
PASSEN_WS=ws://<サーバー>/ws ./venv/bin/python passen_ws.py
```

本番バックエンドではGemini Liveの返答が再生され、続きの発話はウェイクワードなしで
行えます。待機中はPi内で発話開始を検出し、検出前の音声は送信しません。

場所登録を依頼した場合、GPS担当の実装が入るまでは `NOT_IMPLEMENTED` を即座に返します。
サーバーをタイムアウトまで待たせず、Geminiから登録できなかった旨を案内します。

---

## 環境変数

| | 既定 | |
|---|---|---|
| `PASSEN_WS` | `ws://localhost:8080/ws` | 接続先 |
| `PASSEN_WAKE` | `passenger.onnx` | ウェイクワードのモデル。**日本語発音には `passenjaa.onnx` を指定** |
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
車内は暗騒音があるため、起動時に測った環境音から閾値を自動調整します。

---

## 調整が要りそうな数値

`passen_ws.py` の先頭にまとめてあります。

| | 既定 | 効き方 |
|---|---|---|
| `THRESHOLD` | 0.35 | ウェイクワードの判定。誤検出が増えたら上げる |
| `SILENCE_MARGIN` | 2.5 | 起動時に測った暗騒音へ掛ける倍率 |
| `SPEECH_START_SEC` | 5.0 | 初回の呼びかけ後、話し始めるまで待つ秒数 |
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

- **停止スイッチ。** 物理的にマイクを切る手段が要る（プライバシー要件）
- **自動起動。** 今は SSH で手動起動。systemd に登録する
- **GPS実装。** `location_request` への成功応答は担当者の実装待ち。現在は
  `location_error`（`NOT_IMPLEMENTED`）を返す
