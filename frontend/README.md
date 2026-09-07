# パッセン Frontend

Next.js上でGemini Live APIと双方向音声会話を行い、車内で語られた場所の情報をFirestoreへ記録するWebアプリです。

## 音声会話の流れ

1. 「音声をはじめる」を押す
2. Chrome/Edgeの音声認識がウェイクワード「パッセン」を待つ
3. 検出後、`/api/live-token` が1回限りの短命トークンを発行する
4. ブラウザからGemini Live APIへ16kHz PCM音声を直接送信する
5. Geminiの24kHz PCM応答を再生する
6. 場所を記録すべき発話だけ、Function CallingでFirestoreへ保存する

「パッセン、京都に行きたい」のように続けて話した場合、ウェイクワードより後ろの発話もLiveセッションへ引き継ぎます。ウェイクワード検出に非対応のブラウザでは、ボタン操作で直接Live会話を開始します。

## Getting Started

`.env.local.example` を `.env.local` にコピーし、最低限 `GEMINI_API_KEY` を設定します。APIキーはサーバーでのみ使用されるため、変数名に `NEXT_PUBLIC_` を付けないでください。

開発サーバーを起動します。

```bash
npm run dev
```

ChromeまたはEdgeで [http://localhost:3000](http://localhost:3000) を開き、マイクと位置情報を許可してください。スマートフォン実機では、マイク利用のためHTTPSでの配信が必要です（localhostを除く）。

## 保存先

現在は `users/default_user/placeMentions` に発話イベントを保存し、`users/default_user/places` の場所マスタも更新します。保存内容は場所名、意図、発話原文、要約、同行者、気分、寄り道かどうか、発言時の現在地です。Firestoreの永続ローカルキャッシュも有効です。

## 現在の制約

- Firebase Authは未導入で、全端末が仮ユーザー `default_user` を共有します。
- `/api/live-token` は未認証です。本番公開前にユーザー認証とレート制限を追加してください。
- Firestoreルールはデータベース担当のテストモード設定に依存します。本番公開前に匿名認証などを導入し、本人のデータだけ読み書き可能なルールへ変更してください。
- ウェイクワード待機にはWeb Speech APIを使うため、ブラウザによっては音声認識処理が端末外で行われます。
- Gemini Live APIのモデル名はプレビュー期間中に変更されることがあります。その場合は `GEMINI_LIVE_MODEL` を更新します。

## 確認コマンド

```bash
npm run lint
npm run build
```
