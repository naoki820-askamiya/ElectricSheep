import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { buildConversationSummary } from "./visit-drafts.mjs";

function assertUserId(userId) {
  if (typeof userId !== "string" || !userId.trim() || userId.includes("/")) {
    throw new Error("userId が不正です");
  }
  return userId.trim();
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toDateString(value) {
  // 日付を YYYY-MM-DD にそろえる。Firestore の Timestamp と Date と文字列を受ける
  if (!value) return null;
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function publicVisit(visit) {
  return {
    visitedAt: toDateString(visit.visitedAt),
    companions: visit.companions ?? [],
    mood: visit.mood ?? "",
    notableEvent: visit.notableEvent ?? "",
    isDetour: Boolean(visit.isDetour),
  };
}

function byRecency(left, right) {
  // 最近行った順。まだ行っていない場所（行きたい場所）は後ろにまとめる
  if (!left.lastVisitedAt && !right.lastVisitedAt) return 0;
  if (!left.lastVisitedAt) return 1;
  if (!right.lastVisitedAt) return -1;
  return left.lastVisitedAt < right.lastVisitedAt ? 1 : -1;
}

function getAdminFirestore(projectId) {
  const app =
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  return getFirestore(app);
}

export class FirestorePlaceRepository {
  constructor({ projectId, db } = {}) {
    this.db = db ?? getAdminFirestore(projectId);
  }

  placesRef(userId) {
    return this.db.collection("users").doc(assertUserId(userId)).collection("places");
  }

  visitsRef(userId) {
    return this.db.collection("users").doc(assertUserId(userId)).collection("visits");
  }

  async findNearbyPlaces(userId, lat, lng, radiusMeters) {
    const snapshot = await this.placesRef(userId).get();
    return snapshot.docs
      .map((document) => {
        const data = document.data();
        if (
          typeof data.name !== "string" ||
          typeof data.lat !== "number" ||
          typeof data.lng !== "number"
        ) {
          return null;
        }
        const distance = distanceMeters(lat, lng, data.lat, data.lng);
        return distance <= radiusMeters
          ? { id: document.id, name: data.name, distanceMeters: distance }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.distanceMeters - right.distanceMeters);
  }

  async listPlaces(userId, limit = 30) {
    const snapshot = await this.placesRef(userId).get();
    const places = snapshot.docs.map((document) => {
      const data = document.data();
      return {
        id: document.id,
        name: data.name,
        visitCount: data.visitCount ?? 0,
        isFavorite: Boolean(data.isFavorite),
        isWishlist: Boolean(data.isWishlist),
        lastVisitedAt: toDateString(data.lastVisitedAt),
      };
    });
    places.sort(byRecency);

    const top = places.slice(0, limit);
    for (const place of top) {
      try {
        const visits = await this.visitsRef(userId)
          .where("placeId", "==", place.id)
          .orderBy("visitedAt", "desc")
          .limit(1)
          .get();
        const visit = visits.docs[0]?.data();
        if (visit) place.lastVisit = publicVisit(visit);
      } catch {
        // 複合索引が無い環境では読めない。場所の一覧だけでも返す
      }
    }
    return top;
  }

  async commitVisit(draft) {
    const userId = assertUserId(draft.userId);
    const userRef = this.db.collection("users").doc(userId);
    const placesRef = userRef.collection("places");
    const visitsRef = userRef.collection("visits");
    const visitRef = visitsRef.doc();
    const isNewPlace = draft.placeChoice.kind === "new";
    const placeRef = isNewPlace
      ? placesRef.doc()
      : placesRef.doc(draft.placeChoice.placeId);
    const summary = buildConversationSummary(draft);

    await this.db.runTransaction(async (transaction) => {
      const [userSnapshot, placeSnapshot] = await Promise.all([
        transaction.get(userRef),
        isNewPlace ? Promise.resolve(null) : transaction.get(placeRef),
      ]);
      if (placeSnapshot && !placeSnapshot.exists) {
        throw new Error("選択した登録済みの場所が見つかりません");
      }

      if (!userSnapshot.exists) {
        transaction.create(userRef, {
          name: "",
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      if (isNewPlace) {
        transaction.create(placeRef, {
          name: draft.placeChoice.name,
          lat: draft.location.lat,
          lng: draft.location.lng,
          isFavorite: false,
          isWishlist: false,
          visitCount: 1,
          lastVisitedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        });
      } else {
        const currentCount = placeSnapshot.get("visitCount") ?? 0;
        transaction.update(placeRef, {
          visitCount: currentCount + 1,
          lastVisitedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.create(visitRef, {
        placeId: placeRef.id,
        visitedAt: FieldValue.serverTimestamp(),
        companions: draft.companions,
        conversationSummary: summary,
        mood: draft.mood,
        isDetour: draft.isDetour ?? false,
        notableEvent: draft.notableEvent ?? "",
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return {
      placeId: placeRef.id,
      visitId: visitRef.id,
      placeName: draft.placeChoice.name,
      conversationSummary: summary,
    };
  }
}

export class MemoryPlaceRepository {
  constructor() {
    this.places = new Map();
    this.visits = new Map();
    this.nextId = 1;
  }

  async findNearbyPlaces(userId, lat, lng, radiusMeters) {
    return [...this.places.values()]
      .filter((place) => place.userId === userId)
      .map((place) => ({
        ...place,
        distanceMeters: distanceMeters(lat, lng, place.lat, place.lng),
      }))
      .filter((place) => place.distanceMeters <= radiusMeters)
      .sort((left, right) => left.distanceMeters - right.distanceMeters);
  }

  async listPlaces(userId, limit = 30) {
    const places = [...this.places.values()]
      .filter((place) => place.userId === userId)
      .map((place) => {
        const entry = {
          id: place.id,
          name: place.name,
          visitCount: place.visitCount ?? 0,
          isFavorite: Boolean(place.isFavorite),
          isWishlist: Boolean(place.isWishlist),
          lastVisitedAt: toDateString(place.lastVisitedAt),
        };
        const latest = [...this.visits.values()]
          .filter((visit) => visit.placeId === place.id)
          .sort((left, right) => new Date(right.visitedAt) - new Date(left.visitedAt))[0];
        if (latest) entry.lastVisit = publicVisit(latest);
        return entry;
      });
    places.sort(byRecency);
    return places.slice(0, limit);
  }

  seed(userId, places = []) {
    // 発表デモ用の架空データを流し込む。memory モード専用
    for (const place of places) {
      const placeId = `place-${this.nextId++}`;
      this.places.set(placeId, {
        id: placeId,
        userId,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        isFavorite: Boolean(place.isFavorite),
        isWishlist: Boolean(place.isWishlist),
        visitCount: place.visitCount ?? 0,
        lastVisitedAt: place.lastVisitedAt ? new Date(place.lastVisitedAt) : null,
        createdAt: new Date(),
      });
      for (const visit of place.visits ?? []) {
        const visitId = `visit-${this.nextId++}`;
        this.visits.set(visitId, {
          id: visitId,
          userId,
          placeId,
          visitedAt: visit.visitedAt ? new Date(visit.visitedAt) : new Date(),
          companions: visit.companions ?? [],
          conversationSummary: visit.notableEvent ?? "",
          mood: visit.mood ?? "",
          isDetour: Boolean(visit.isDetour),
          notableEvent: visit.notableEvent ?? "",
          createdAt: new Date(),
        });
      }
    }
    return this.places.size;
  }

  async commitVisit(draft) {
    let placeId;
    if (draft.placeChoice.kind === "existing") {
      placeId = draft.placeChoice.placeId;
      const place = this.places.get(placeId);
      if (!place || place.userId !== draft.userId) {
        throw new Error("選択した登録済みの場所が見つかりません");
      }
      place.visitCount += 1;
      place.lastVisitedAt = new Date();
    } else {
      placeId = `place-${this.nextId++}`;
      this.places.set(placeId, {
        id: placeId,
        userId: draft.userId,
        name: draft.placeChoice.name,
        lat: draft.location.lat,
        lng: draft.location.lng,
        isFavorite: false,
        isWishlist: false,
        visitCount: 1,
        lastVisitedAt: new Date(),
        createdAt: new Date(),
      });
    }

    const visitId = `visit-${this.nextId++}`;
    const summary = buildConversationSummary(draft);
    this.visits.set(visitId, {
      id: visitId,
      userId: draft.userId,
      placeId,
      visitedAt: new Date(),
      companions: draft.companions,
      conversationSummary: summary,
      mood: draft.mood,
      isDetour: draft.isDetour ?? false,
      notableEvent: draft.notableEvent ?? "",
      createdAt: new Date(),
    });
    return {
      placeId,
      visitId,
      placeName: draft.placeChoice.name,
      conversationSummary: summary,
    };
  }
}

export function createPlaceRepository(config) {
  return config.dbMode === "memory"
    ? new MemoryPlaceRepository()
    : new FirestorePlaceRepository({ projectId: config.firebaseProjectId });
}
