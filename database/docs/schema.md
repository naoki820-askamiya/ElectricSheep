# Firestoreスキーマ設計

## コレクション構成

```
users/{userId}
  name              string
  createdAt         timestamp

users/{userId}/places/{placeId}
  name              string   地名
  normalizedName    string   名寄せ用に正規化した地名
  lat               number | null   場所そのものの緯度(未解決ならnull)
  lng               number | null   場所そのものの経度(未解決ならnull)
  isFavorite        bool     お気に入りフラグ
  isWishlist        bool     行きたい場所フラグ
  visitCount        number   訪問回数(訪問のたびに+1)
  lastVisitedAt     timestamp | null   最終訪問日時
  lastMentionedAt   timestamp | null   会話で最後に言及した日時
  createdAt         timestamp

users/{userId}/placeMentions/{mentionId}
  placeId           string   places のドキュメントID
  placeName         string   発話から抽出した地名
  normalizedName    string   名寄せ用に正規化した地名
  intent            string   destination | wishlist | visited | memory
  originalUtterance string   記録判断の根拠になった発話原文
  summary           string   Geminiによる短い要約
  companions        array<string>   発話から明示的に分かる同行者
  mood              string   発話から明示的に分かる気分
  isDetour          bool     寄り道かどうか
  currentLat        number | null   発言時点の車の緯度
  currentLng        number | null   発言時点の車の経度
  source            string   gemini-live
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
- `placeMentions` は「会話で何が語られたか」を失わないための追記型イベント。`places` は検索しやすい現在状態、`placeMentions` は判定根拠と文脈という役割に分ける。
- `currentLat/currentLng` は発言時の車の現在地であり、話題に出た場所の座標ではない。目的地座標として `places.lat/lng` にコピーしない。

## 典型的なクエリ

| やりたいこと | クエリ |
| --- | --- |
| 1年前の今日行った場所 | `visits` を `visitedAt` の範囲(前後1日など)で検索 |
| ある場所の訪問回数 | `places/{placeId}.visitCount` を参照 |
| 寄り道の思い出 | `visits` を `isDetour == true` で絞り込み |
| 行きたい場所一覧 | `places` を `isWishlist == true` で絞り込み |

## 今後の検討事項

- 認証(Firebase Auth)を導入する際、`users/{userId}` の `userId` をどう決めるか(端末ごとの匿名ID、家族アカウントなど)
- `firestore.rules` は現在テストモード(全許可)。認証導入後に `request.auth.uid == userId` ベースのルールへ切り替える
- 写真・音声など大きいデータを扱う場合は Cloud Storage との併用を検討
