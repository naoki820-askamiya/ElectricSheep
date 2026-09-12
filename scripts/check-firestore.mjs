// Firestore に本当に繋がるかを確かめる。鍵をもらったら最初にこれを実行する。
//   npm run check:db          読み取りだけ試す
//   npm run check:db -- --write  試し書きと削除まで試す
//
// 会話の本体とは独立しているので、Gemini のキーが無くても動く。
import "../server/config.mjs"; // .env.local を読み込むために先に通す
import { FirestorePlaceRepository } from "../server/place-repository.mjs";

const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || "hakkason-database";
const userId = process.env.PASSEN_FIRESTORE_USER_ID?.trim() || "pi-demo";
const wantWrite = process.argv.includes("--write");

console.log(`プロジェクト: ${projectId}`);
console.log(`ユーザー: ${userId}`);
console.log(
  `鍵: ${process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || "(未設定。gcloud のログイン情報を探します)"}`,
);
console.log("");

try {
  const repository = new FirestorePlaceRepository({ projectId });

  // 会話と同じ条件（30件）で読む。全件の中身は多いので、表示は先頭だけにする
  const places = await repository.listPlaces(userId, 30);
  const shown = places.slice(0, 5);
  console.log(`読み取り: 成功。場所 ${places.length} 件`);
  for (const place of shown) {
    const visit = place.lastVisit;
    const detail = visit
      ? `最後 ${visit.visitedAt} / ${visit.companions.join("、") || "同行者なし"}`
      : "訪問の記録は読めませんでした";
    console.log(`  - ${place.name}（${place.visitCount}回）${detail}`);
  }
  if (places.length > shown.length) {
    console.log(`  （ほか ${places.length - shown.length} 件。表示を先頭5件に省略しています）`);
  }
  if (places.length > 0 && !places.some((place) => place.lastVisit)) {
    console.log("  ※ 場所は読めるのに訪問が読めない場合、複合索引が要ります（上の警告のURLから作成）");
  }

  if (wantWrite) {
    const ref = repository.db
      .collection("users").doc(userId)
      .collection("_healthcheck").doc("probe");
    await ref.set({ at: new Date().toISOString() });
    const saved = await ref.get();
    await ref.delete();
    console.log(`書き込み: ${saved.exists ? "成功（確認後に削除しました）" : "失敗（書けていません）"}`);
  } else {
    console.log("書き込み: 未確認（--write を付けると試します）");
  }

  console.log("\n繋がりました。PASSEN_DB_MODE=firestore で起動できます。");
  process.exit(0);
} catch (error) {
  console.error("\n繋がりませんでした。");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
