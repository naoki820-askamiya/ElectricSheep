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
| 位置情報（要求されたときだけ返す） | **実装済み。実機で 3D FIX を確認** |

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

# GPS 単体（屋外・空が見える場所で）
./venv/bin/python gps_reader.py
```

### GPS を使う前に gpsd を止める

**これを忘れると必ず詰まります。** `gpsd` はシリアルポートを占有するため、
`gps_reader.py` が同じポートを開けません。症状は「データが出てこない」です。

```bash
sudo systemctl mask gpsd.socket gpsd.service
sudo pkill -x gpsd
sudo fuser -v /dev/ttyACM0     # 誰が掴んでいるか確認
```

`stop` や `disable` では足りません。**`gpsd.socket` は繋がれた瞬間に起動する**
仕組みなので、すぐ復活します。`mask` で起動そのものを禁止してください。

さらに `gpsd` は受信機へ設定コマンドを送り、**出力する NMEA 文を変えてしまいます。**
実機では GGA と GSV が出なくなりました。u-blox は設定をバックアップ電源付きメモリに
持つため、USBを抜き差ししても戻りません。戻すにはこれを実行します。

```bash
./venv/bin/python gps_reset.py
```

`gps_reader.py` を実行すると1秒ごとに状態が出ます。

```
35.07040, 137.23241  ±11m  衛星8個  0秒前
```

`未測位` のままなら屋内である可能性が高いです。実機では**窓際で26秒**かかりました。
詳しくは [../docs/gps-notes.md](../docs/gps-notes.md)。

---

## ファイル

| | |
|---|---|
| `passen_ws.py` | **本体。** ウェイクワード → 音声送信 → 返事の再生 |
| `gps_reader.py` | USB GPS を常時読み、最新の座標を保持する。単体実行で確認できる |
| `gps_reset.py` | 受信機の設定を工場出荷時に戻す。`gpsd` に設定を壊されたときに使う |
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
| `PASSEN_GPS` | `on` | `off` にすると GPS を使わない（GPS無しの機体でも動く） |
| `PASSEN_GPS_PORT` | 自動検出 | GPSのシリアルポート |
| `PASSEN_GPS_BAUD` | `9600` | シリアル通信速度 |
| `PASSEN_GPS_MAX_AGE_SEC` | `15` | キャッシュした座標を有効とみなす秒数 |
| `PASSEN_GPS_TIMEOUT_SEC` | `5` | 位置情報要求を受けて待機する最大秒数 |

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
「話し始めるまで」と「話し終わってから」を別々に測っています。呼びかけたあと
5秒は沈黙してよく、話し始めてから1.2秒の沈黙で終了とみなします。
両方を同じ長さにすると、考えている間に打ち切られて声が一切録れませんでした。

無音の基準は起動時に環境音を測って決めます。車内は暗騒音があるため、
固定値では場所が変わると合いません。

**位置情報は要求されたときだけ送ります。**
GPS は起動中ずっと読んでキャッシュしていますが、`location_request` を
受けるまで外へ出しません。測位に数十秒かかるため常時読み、
プライバシーのため常時送信はしない、という両立です。

**GPS が壊れていても会話は止まりません。**
未接続・未測位・古い座標のいずれでも `location_error` を返して続行します。

---

## 調整が要りそうな数値

`passen_ws.py` の先頭にまとめてあります。

| | 既定 | 効き方 |
|---|---|---|
| `THRESHOLD` | 0.35 | ウェイクワードの判定。**0.4 が上限**（[理由](models/README.md)） |
| `SILENCE_MARGIN` | 2.5 | 起動時に測った暗騒音へ掛ける倍率 |
| `SILENCE_RMS_MIN` / `MAX` | 500 / 3000 | 自動調整の下限と上限 |
| `SPEECH_START_SEC` | 5.0 | 初回の呼びかけ後、話し始めるまで待つ秒数 |
| `SILENCE_SEC` | 1.2 | 話し終わってから何秒黙ったら終了とみなすか |
| `UTTERANCE_MAX_SEC` | 10.0 | 話し始めてからの上限 |

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
- **実機での通しテスト。** GPS を挿した状態で passen_ws.py を動かす確認が未実施
