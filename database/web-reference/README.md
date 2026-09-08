# web-reference

Next.jsプロジェクトができたら、`firebase.ts` と `db.ts` をそのまま `src/lib/` などにコピーして使う想定の参考実装です。

## 使い方

1. Next.jsプロジェクトで `npm install firebase` を実行
2. `firebase.ts` と `db.ts` を `src/lib/` にコピー
3. コンポーネント側から `import { addVisit, getWishlist } from "@/lib/db"` のように呼び出す

## 注意点

- `getVisitsForPlace` は `placeId` で絞り込みつつ `visitedAt` で並び替える複合クエリのため、Firestoreの複合インデックスが必要。これは `cloud/firestore.indexes.json` に定義済み・デプロイ済みなので、そのまま動作するはず
- 匿名認証(`signInAnonymously`)を導入済み。`db.ts` の各関数は `userId` を省略すると `firebase.ts` の `currentUserId`(サインイン完了後のuidに解決されるPromise)を自動で使う
- `cloud/firestore.rules` も `request.auth.uid == userId` ベースの本実装に切り替え済み。ただし **Firebaseコンソールで匿名認証プロバイダを有効化** し、`firebase deploy --only firestore:rules` で **デプロイ** するまでは反映されない(詳細は `docs/progress.md`)
- `db.ts` の関数は `device/firestore_client.py`(Python版・Raspberry Pi用に用意していたが現在は動作確認用)と同じスキーマ・同じ役割の関数群
- `findOrCreatePlace(lat, lng)` は、現在地の近く(デフォルト半径100m以内)に登録済みの場所があればそれを使い、なければ [Nominatim](https://nominatim.openstreetmap.org/)(OpenStreetMapの無料逆ジオコーディングAPI)で地名を調べて新規登録する。GPSで現在地を検知するたびに毎回呼ぶのではなく、「新しい場所に着いたと判断したとき」など呼び出し頻度を抑えて使うこと(Nominatimの利用ポリシー上、過度な連続呼び出しは避ける)
