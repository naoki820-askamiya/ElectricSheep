# Firestore

Next.jsアプリが利用するFirebase Cloud Firestoreの実装です。接続先は既定で
Firebaseプロジェクト `hakkason-database`、データベース `(default)` です。

## ファイル

- `firebase.ts` — Firebase Web SDKとIndexedDB永続キャッシュの初期化
- `db.ts` — スキーマ型とデータ操作関数
- `docs/schema.md` — Firestoreのコレクション設計
- `cloud/` — Firebase CLI用のルール、インデックス、プロジェクト設定
- `device/` — 旧Python版の接続・スキーマ確認用コード

## アプリから使う

```ts
import {
  addPlace,
  addVisit,
  getFavorites,
  getPlaces,
  getVisitsForPlace,
  getWishlist,
} from "@/database/db";
```

FirebaseのWeb設定には既存プロジェクトの値が既定値として入っています。別プロジェクトを
使う場合だけ、ルートの `.env.local.example` に記載された
`NEXT_PUBLIC_FIREBASE_*` を `.env.local` で上書きしてください。

## 訪問を記録する手順

場所と訪問は別のコレクションです。初めての場所なら `addPlace()` で場所マスターを作り、
訪問のたびに `addVisit()` を呼びます。

```ts
const placeId = await addPlace("鈴鹿サーキット", 34.8431, 136.5417);

await addVisit(placeId, {
  companions: ["父", "母"],
  conversationSummary: "子供の頃に見たレースの話で盛り上がった",
  mood: "懐かしい",
});
```

`addVisit()` は1つのトランザクションで次の3項目を更新します。

1. `visits` に訪問履歴を作成
2. 対応する `places.visitCount` を1増加
3. `places.lastVisitedAt` を訪問時刻へ更新

`findOrCreatePlace()` を使うと、指定座標の100m以内に既存場所があればそのIDを返し、
なければNominatimで地名を取得して場所マスターを登録します。逆ジオコーディングAPIの
利用ポリシー上、現在地の更新ごとではなく到着判定時など低頻度で呼んでください。

## 注意点

- Firebase Authは未導入で、現在は `DEFAULT_USER_ID` を使用します。
- セキュリティルールはテスト用です。本番公開前に認証とユーザー単位のルールが必要です。
- `getVisitsForPlace()` に必要な複合インデックスは `cloud/firestore.indexes.json` にあります。
