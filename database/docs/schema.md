# Firestoreスキーマ設計

## コレクション構成

```
users/{userId}
  name              string
  createdAt         timestamp

users/{userId}/places/{placeId}
  name              string   地名
  lat               number   緯度
  lng               number   経度
  isFavorite        bool     お気に入りフラグ
  isWishlist        bool     行きたい場所フラグ
  visitCount        number   訪問回数(訪問のたびに+1)
  lastVisitedAt     timestamp | null   最終訪問日時
  createdAt         timestamp

users/{userId}/visits/{visitId}
  placeId           string   どの場所か(places のドキュメントID)
  visitedAt         timestamp   訪問日時
  companions        array<string>   同行者
  conversationSummary  string   会話の要約
  mood              string   そのときの気分
  isDetour          bool     予定外の寄り道だったか
  notableEvent      string   印象に残った出来事(なければ空文字)
  createdAt         timestamp
```

## 設計方針

- `places` と `visits` を分離。同じ場所への複数回の訪問は、`places` 1件に対し `visits` が複数紐づく形。
- `places.visitCount` / `lastVisitedAt` は `visits` から集計可能な値だが、会話応答の速度を優先してあえて非正規化(重複保持)している。訪問記録を追加するたびに、アプリ側の責任でこの2つを更新する。
- お気に入り/行きたい場所/訪問済みは別コレクションに分けず、`places` のフラグで管理。「行きたい場所として登録→実際に訪れた」という履歴が同じドキュメントで自然に追える。

## 典型的なクエリ

| やりたいこと | クエリ |
| --- | --- |
| 1年前の今日行った場所 | `visits` を `visitedAt` の範囲(前後1日など)で検索。`web-reference/db.ts` の `getMemoriesOnThisDay()` として実装済み |
| ある場所の訪問回数 | `places/{placeId}.visitCount` を参照 |
| 寄り道の思い出 | `visits` を `isDetour == true` で絞り込み |
| 行きたい場所一覧 | `places` を `isWishlist == true` で絞り込み |

## 認証

Firebase Authの匿名認証(`signInAnonymously`)を導入した。`users/{userId}` の `userId` は、匿名サインインで発行される `auth.currentUser.uid` をそのまま使う(端末ごとに1つ、ブラウザに保存され再訪問時も同じuidが復元される)。

`firestore.rules` は `request.auth.uid == userId` ベースの本実装に切り替え、公開済み。Firebaseコンソールで匿名認証プロバイダを有効化し、自動クリーンアップはOFFにしてある(30日でアカウントが消えると一生分の思い出が迷子になるため)。詳細は[`docs/progress.md`](./progress.md)参照。

## 今後の検討事項

- 家族アカウントなど、匿名認証だけでは表現できない共有の仕組みが必要になった場合の設計
- 写真・音声など大きいデータを扱う場合は Cloud Storage との併用を検討
