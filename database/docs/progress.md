# 進捗状況(データベース担当)

最終更新: 2026-09-07

## 全体の役割分担

当初は「車載デバイス(Raspberry Pi)/スマートフォン/クラウド」の3層構成だったが、
Raspberry Piでの実装コストが高いため、以下の役割分担に変更した。

- **Raspberry Pi**: 将来のローカル応答レイヤー候補。現行のWeb実装では使用しない
- **スマートフォン(Next.jsアプリ)**: ウェイクワード、Gemini Live音声会話、位置情報、UI表示、Firestoreへの読み書き(ローカルキャッシュも兼ねる)
- **クラウド(Firestore)**: 正データとして永続化・同期

データベースは実質「スマホのローカルキャッシュ + クラウド」の2層構成。

## 環境構築

- Python 3.12、Git、Firebase CLIをインストール
- プロジェクトフォルダ `C:\Users\yuzuki\ElectricSheep` を作成し、Gitで管理

## クラウド側(Firebase / Firestore)

- Firebaseプロジェクト「hakkason-database」を作成(Firestore, Standardエディション, defaultデータベース, テストモード)
- Webアプリ「ElectricSheep_bag」を登録し、`firebaseConfig` を取得済み(`web-reference/firebase.ts` に反映済み)
- `cloud/` フォルダに `firebase init firestore` でFirebase設定を配置
  - `firebase.json` / `.firebaserc` / `firestore.rules` / `firestore.indexes.json`
- 複合インデックスを1つデプロイ済み(`visits` コレクションを `placeId` + `visitedAt` で検索するため)
- **セキュリティルールは未対応**(テストモードのまま、誰でも読み書き可能)
- **課金プランはSpark(無料)のまま**。クレジットカード登録なし

## データ設計(スキーマ)

詳細は [`docs/schema.md`](./schema.md) を参照。

```
users/{userId}
  └ places/{placeId}   場所のマスタ(名前・座標・お気に入り/行きたい場所フラグ・訪問回数など)
  └ visits/{visitId}    訪問記録(日時・同行者・会話要約・気分・寄り道フラグなど)
  └ placeMentions/{mentionId}  Gemini Liveが会話から抽出した場所発言
```

## 実装したコード

### `device/`(Python・動作確認用)

もとはRaspberry Pi用に用意したが、役割分担の変更により**現在はスキーマの動作確認ツール**という位置づけ。

- `firestore_client.py` — Firestoreへの読み書き関数一式
- `test_connection.py` — 接続確認用スクリプト(実行済み、成功)
- `test_schema.py` — スキーマ通りにデータが書き込めるか確認するスクリプト(実行済み、成功)

### `web-reference/`(TypeScript・Next.js向け本命コード)

Next.jsプロジェクトができ次第、`src/lib/` などにコピーして使う想定。

- `firebase.ts` — Firebase Web SDKの初期化。オフラインキャッシュ(`persistentLocalCache`)を有効化済み。これが端末側ローカルDBの役割を担う
- `db.ts` — データ操作関数
  - `addPlace` / `addVisit` — 場所・訪問記録の保存
  - `getWishlist` / `getFavorites` — カテゴリ別の取得
  - `getVisitsForPlace` — ある場所の訪問履歴を取得
  - `findOrCreatePlace(lat, lng)` — GPS座標から近くの既存の場所を探し、なければNominatim(無料の逆ジオコーディングAPI)で地名を取得して自動登録
- `README.md` — 組み込み方・注意点

### `frontend/`(Next.js・現行実装)

- Gemini Live APIへブラウザから接続する短命トークン発行Route Handler
- 「パッセン」のウェイクワード検出と、16kHz PCM入力 / 24kHz PCM応答再生
- Function Calling `record_place_mention` から `places` / `placeMentions` への一括保存
- Firestoreの永続ローカルキャッシュ

## 未着手のタスク

優先度が高い順:

1. **認証(Firebase Auth)** — 現在は `DEFAULT_USER_ID` という仮のIDで全データを1人分として扱っている。匿名認証の導入を検討中
2. **セキュリティルールの本実装** — テストモードのままなので、認証導入後に「自分のデータしか読み書きできない」ルールへ切り替える必要がある
3. **「1年前の今日」のような想起クエリ** — まだ関数として実装していない
4. **訪問確定フロー** — 場所への言及(`placeMentions`)を、実際の訪問(`visits`)へ確定する条件と処理は未設計
5. **Raspberry Pi→スマホのデータ連携方法** — Raspberry Pi層を再導入する場合のBluetoothなどは未設計
