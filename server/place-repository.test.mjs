import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPlaceRepository } from "./place-repository.mjs";
import { LiveToolController } from "./live-tools.mjs";

const USER = "pi-demo";

function repositoryWithWish(name = "能登の千枚田", reason = "テレビで見て気になっている") {
  const repository = new MemoryPlaceRepository();
  return repository
    .rememberWish(USER, { name, reason })
    .then((saved) => ({ repository, saved }));
}

test("行きたい場所を記録すると、まだ行っていない場所として一覧に出る", async () => {
  const { repository, saved } = await repositoryWithWish();
  assert.equal(saved.alreadyKnown, false);

  const places = await repository.listPlaces(USER);
  assert.equal(places.length, 1);
  assert.equal(places[0].name, "能登の千枚田");
  assert.equal(places[0].isWishlist, true);
  assert.equal(places[0].visitCount, 0);
  assert.equal(places[0].lastVisitedAt, null);
  assert.equal(places[0].note, "テレビで見て気になっている");
});

test("同じ場所を二度話しても増えず、理由だけ新しくなる", async () => {
  const { repository } = await repositoryWithWish();
  const again = await repository.rememberWish(USER, {
    name: "能登の千枚田",
    reason: "棚田を見てみたい",
  });

  assert.equal(again.alreadyKnown, true);
  const places = await repository.listPlaces(USER);
  assert.equal(places.length, 1);
  assert.equal(places[0].note, "棚田を見てみたい");
});

test("場所の名前が無いときは記録せずに失敗する", async () => {
  const repository = new MemoryPlaceRepository();
  await assert.rejects(() => repository.rememberWish(USER, { name: "   " }));
  await assert.rejects(() => repository.rememberWish(USER, {}));
  assert.equal((await repository.listPlaces(USER)).length, 0);
});

test("行きたい場所は座標を持たないので、現在地の候補には出てこない", async () => {
  const { repository } = await repositoryWithWish();
  const nearby = await repository.findNearbyPlaces(USER, 35.07, 137.23, 100);
  assert.deepEqual(nearby, []);
});

test("実際に訪れたら、行きたい場所ではなくなる", async () => {
  const { repository, saved } = await repositoryWithWish();
  await repository.commitVisit({
    userId: USER,
    placeChoice: { kind: "existing", placeId: saved.placeId, name: "能登の千枚田" },
    location: { lat: 37.4589, lng: 137.1006 },
    companions: ["妻のゆづきさん"],
    mood: "うれしい",
    isDetour: false,
    notableEvent: "",
  });

  const places = await repository.listPlaces(USER);
  assert.equal(places[0].isWishlist, false);
  assert.equal(places[0].visitCount, 1);
  assert.equal(places[0].lastVisit.companions[0], "妻のゆづきさん");
});

test("他の人の記録は混ざらない", async () => {
  const { repository } = await repositoryWithWish();
  assert.equal((await repository.listPlaces("別のユーザー")).length, 0);
});

test("ツールから呼んでも記録でき、覚えたと伝える指示が返る", async () => {
  const repository = new MemoryPlaceRepository();
  const controller = new LiveToolController({
    sessionId: "s1",
    userId: USER,
    placeRepository: repository,
  });

  const result = await controller.execute("remember_wish", {
    name: "美ら海水族館",
    reason: "孫と行く約束をした",
  });
  assert.equal(result.ok, true);
  assert.equal(result.saved.name, "美ら海水族館");
  assert.match(result.instruction, /覚えた/);

  const recalled = await controller.execute("recall_places");
  assert.equal(recalled.places[0].isWishlist, true);
  assert.equal(recalled.places[0].note, "孫と行く約束をした");
});
