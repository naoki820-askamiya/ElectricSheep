# 進捗状況(データベース担当)

最終更新: 2026-08-22

## 全体の役割分担

当初は「車載デバイス(Raspberry Pi)/スマートフォン/クラウド」の3層構成だったが、
Raspberry Piでの実装コストが高いため、以下の役割分担に変更した。

- **Raspberry Pi**: 音声会話のみを担当(ウェイクワード、会話AI)。データベースには直接アクセスしない
- **スマートフォン(Next.jsアプリ)**: 位置情報の取得、UI表示、Firestoreへの読み書き(ローカルキャッシュも兼ねる)
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

## 未着手のタスク

優先度が高い順:

1. **認証(Firebase Auth)** — 現在は `DEFAULT_USER_ID` という仮のIDで全データを1人分として扱っている。匿名認証の導入を検討中
2. **セキュリティルールの本実装** — テストモードのままなので、認証導入後に「自分のデータしか読み書きできない」ルールへ切り替える必要がある
3. **「1年前の今日」のような想起クエリ** — まだ関数として実装していない
4. **Next.jsプロジェクトへの統合** — プロジェクト自体がまだ存在しないため未着手。できたら `web-reference/` の中身をコピーする
5. **会話要約・気分データの書き込み元の調整** — Gemini連携(なおき担当)からどう `addVisit()` を呼ぶかの繋ぎ込み
6. **Raspberry Pi→スマホのデータ連携方法** — Bluetoothなどでの連携方法は未設計
