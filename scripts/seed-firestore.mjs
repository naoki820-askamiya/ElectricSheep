// 発表デモ用の架空データを Firestore へ入れる／消す。
//   npm run seed:db            入れる（同じものが既にあれば入れ直す）
//   npm run seed:db -- --clear このスクリプトが入れたものだけ消す
//
// 入れた記録には demo: true を付ける。消すときはこの印が付いたものだけを対象にするので、
// 本物の記録は消えない。既定の保存先は架空データ側の userId（pi-demo）で、
// チームの default_user とは別の場所に入る。
import "../server/config.mjs"; // .env.local を読み込むために先に通す
import { readFileSync } from "node:fs";
import { FirestorePlaceRepository } from "../server/place-repository.mjs";

const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || "hakkason-database";
const seedFile = process.env.PASSEN_SEED_FILE?.trim() || "server/demo-seed.json";
const wantClear = process.argv.includes("--clear");
const userArg = process.argv.find((value) => value.startsWith("--user="));

const seed = JSON.parse(readFileSync(seedFile, "utf8"));
const userId = userArg ? userArg.slice("--user=".length) : seed.userId;

console.log(`プロジェクト: ${projectId}`);
console.log(`保存先ユーザー: ${userId}`);
console.log(`架空データ: ${seedFile}`);
console.log("");

const repository = new FirestorePlaceRepository({ projectId });
const placesRef = repository.db.collection("users").doc(userId).collection("places");
const visitsRef = repository.db.collection("users").doc(userId).collection("visits");

async function removeDemo() {
  let removed = 0;
  for (const ref of [placesRef, visitsRef]) {
    const snapshot = await ref.where("demo", "==", true).get();
    for (const document of snapshot.docs) {
      await document.ref.delete();
      removed += 1;
    }
  }
  return removed;
}

try {
  const removed = await removeDemo();
  if (removed > 0) console.log(`前に入れた架空データ ${removed} 件を消しました`);

  if (wantClear) {
    console.log(removed > 0 ? "消し終わりました。" : "消す架空データはありませんでした。");
    process.exit(0);
  }

  const batch = repository.db.batch();
  let visitCount = 0;
  for (const place of seed.places ?? []) {
    const placeRef = placesRef.doc();
    batch.set(placeRef, {
      name: place.name,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      isFavorite: Boolean(place.isFavorite),
      isWishlist: Boolean(place.isWishlist),
      visitCount: place.visitCount ?? 0,
      note: place.note ?? "",
      lastVisitedAt: place.lastVisitedAt ? new Date(place.lastVisitedAt) : null,
      createdAt: new Date(),
      demo: true,
    });
    for (const visit of place.visits ?? []) {
      batch.set(visitsRef.doc(), {
        placeId: placeRef.id,
        visitedAt: visit.visitedAt ? new Date(visit.visitedAt) : new Date(),
        companions: visit.companions ?? [],
        conversationSummary: visit.notableEvent ?? "",
        mood: visit.mood ?? "",
        isDetour: Boolean(visit.isDetour),
        notableEvent: visit.notableEvent ?? "",
        createdAt: new Date(),
        demo: true,
      });
      visitCount += 1;
    }
  }
  await batch.commit();
  console.log(`場所 ${(seed.places ?? []).length} 件、訪問 ${visitCount} 件を入れました`);

  const places = await repository.listPlaces(userId, 30);
  console.log(`\n読み直した結果: ${places.length} 件`);
  for (const place of places) {
    const mark = place.isWishlist ? "行きたい" : `${place.visitCount}回`;
    const visit = place.lastVisit
      ? `${place.lastVisit.visitedAt} / ${place.lastVisit.companions.join("、") || "同行者なし"}`
      : "※訪問が読めません（複合索引が必要）";
    console.log(`  - ${place.name}（${mark}）${visit}`);
  }
  process.exit(0);
} catch (error) {
  console.error("\n失敗しました。");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
