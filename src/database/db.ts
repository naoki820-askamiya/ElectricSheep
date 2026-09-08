import "client-only";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

/** Firebase Auth 導入まで全クライアントで共有する仮ユーザーID。 */
export const DEFAULT_USER_ID = "default_user";

export type User = {
  id: string;
  name: string;
  createdAt: Timestamp;
};

/** Firestore の users/{userId}/places/{placeId} と同じ構造。 */
export type Place = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  isFavorite: boolean;
  isWishlist: boolean;
  visitCount: number;
  lastVisitedAt: Timestamp | null;
  createdAt: Timestamp;
};

/** Firestore の users/{userId}/visits/{visitId} と同じ構造。 */
export type Visit = {
  id: string;
  placeId: string;
  visitedAt: Timestamp;
  companions: string[];
  conversationSummary: string;
  mood: string;
  isDetour: boolean;
  notableEvent: string;
  createdAt: Timestamp;
};

export type AddVisitOptions = {
  companions?: string[];
  conversationSummary?: string;
  mood?: string;
  isDetour?: boolean;
  notableEvent?: string;
};

export type UpdatePlaceInput = Partial<
  Pick<Place, "name" | "lat" | "lng" | "isFavorite" | "isWishlist">
>;

function userRef(userId: string = DEFAULT_USER_ID) {
  return doc(db, "users", userId);
}

function placesRef(userId: string = DEFAULT_USER_ID) {
  return collection(db, "users", userId, "places");
}

function visitsRef(userId: string = DEFAULT_USER_ID) {
  return collection(db, "users", userId, "visits");
}

function withId<T>(snapshot: QueryDocumentSnapshot<DocumentData>): T & { id: string } {
  return { id: snapshot.id, ...snapshot.data() } as T & { id: string };
}

/** users/{userId} がなければ、スキーマどおり親ドキュメントを作る。 */
export async function ensureUser(
  userId: string = DEFAULT_USER_ID,
  name = "",
): Promise<void> {
  const ref = userRef(userId);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    await runTransaction(db, async (transaction) => {
      const latest = await transaction.get(ref);
      if (!latest.exists()) {
        transaction.set(ref, { name, createdAt: serverTimestamp() });
      }
    });
  }
}

/** 場所マスターを登録する。訪問履歴は addVisit で別に記録する。 */
export async function addPlace(
  name: string,
  lat: number,
  lng: number,
  isFavorite = false,
  isWishlist = false,
  userId: string = DEFAULT_USER_ID,
): Promise<string> {
  await ensureUser(userId);

  const docRef = await addDoc(placesRef(userId), {
    name,
    lat,
    lng,
    isFavorite,
    isWishlist,
    visitCount: 0,
    lastVisitedAt: null,
    createdAt: serverTimestamp(),
  });

  return docRef.id;
}

/**
 * 訪問履歴の作成と places の集計値更新を、1つのトランザクションで行う。
 * これが docs/schema.md で定められた訪問記録手順になる。
 */
export async function addVisit(
  placeId: string,
  options: AddVisitOptions = {},
  userId: string = DEFAULT_USER_ID,
): Promise<string> {
  const visitDocRef = doc(visitsRef(userId));
  const placeDocRef = doc(placesRef(userId), placeId);

  await runTransaction(db, async (transaction) => {
    const placeSnapshot = await transaction.get(placeDocRef);
    if (!placeSnapshot.exists()) {
      throw new Error(`訪問先の場所が存在しません: ${placeId}`);
    }

    const currentCount = (placeSnapshot.data().visitCount as number | undefined) ?? 0;

    transaction.set(visitDocRef, {
      placeId,
      visitedAt: serverTimestamp(),
      companions: options.companions ?? [],
      conversationSummary: options.conversationSummary ?? "",
      mood: options.mood ?? "",
      isDetour: options.isDetour ?? false,
      notableEvent: options.notableEvent ?? "",
      createdAt: serverTimestamp(),
    });
    transaction.update(placeDocRef, {
      visitCount: currentCount + 1,
      lastVisitedAt: serverTimestamp(),
    });
  });

  return visitDocRef.id;
}

export async function getPlace(
  placeId: string,
  userId: string = DEFAULT_USER_ID,
): Promise<Place | null> {
  const snapshot = await getDoc(doc(placesRef(userId), placeId));
  return snapshot.exists()
    ? ({ id: snapshot.id, ...snapshot.data() } as Place)
    : null;
}

export async function getPlaces(
  userId: string = DEFAULT_USER_ID,
): Promise<Place[]> {
  const snapshot = await getDocs(placesRef(userId));
  return snapshot.docs.map((item) => withId<Omit<Place, "id">>(item));
}

export async function getWishlist(
  userId: string = DEFAULT_USER_ID,
): Promise<Place[]> {
  const snapshot = await getDocs(
    query(placesRef(userId), where("isWishlist", "==", true)),
  );
  return snapshot.docs.map((item) => withId<Omit<Place, "id">>(item));
}

export async function getFavorites(
  userId: string = DEFAULT_USER_ID,
): Promise<Place[]> {
  const snapshot = await getDocs(
    query(placesRef(userId), where("isFavorite", "==", true)),
  );
  return snapshot.docs.map((item) => withId<Omit<Place, "id">>(item));
}

export async function updatePlace(
  placeId: string,
  updates: UpdatePlaceInput,
  userId: string = DEFAULT_USER_ID,
): Promise<void> {
  await updateDoc(doc(placesRef(userId), placeId), updates);
}

export async function getVisitsForPlace(
  placeId: string,
  userId: string = DEFAULT_USER_ID,
): Promise<Visit[]> {
  const snapshot = await getDocs(
    query(
      visitsRef(userId),
      where("placeId", "==", placeId),
      orderBy("visitedAt"),
    ),
  );
  return snapshot.docs.map((item) => withId<Omit<Visit, "id">>(item));
}

function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const earthRadiusMeters = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRad(lat2 - lat1);
  const deltaLng = toRad(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(deltaLng / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type NominatimResponse = {
  namedetails?: { name?: string };
  display_name?: string;
};

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const params = new URLSearchParams({
    format: "json",
    lat: String(lat),
    lon: String(lng),
    zoom: "18",
    addressdetails: "1",
    namedetails: "1",
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
  );

  if (!response.ok) {
    throw new Error(`Nominatim request failed: ${response.status}`);
  }

  const data = (await response.json()) as NominatimResponse;
  return (
    data.namedetails?.name ??
    data.display_name?.split(",")[0] ??
    "名称未設定の場所"
  );
}

/** 100m以内の登録場所を再利用し、なければ逆ジオコーディングして作成する。 */
export async function findOrCreatePlace(
  lat: number,
  lng: number,
  userId: string = DEFAULT_USER_ID,
  radiusMeters = 100,
): Promise<string> {
  const places = await getPlaces(userId);
  const nearby = places.find(
    (place) =>
      haversineDistanceMeters(lat, lng, place.lat, place.lng) <= radiusMeters,
  );

  if (nearby) return nearby.id;

  const name = await reverseGeocode(lat, lng);
  return addPlace(name, lat, lng, false, false, userId);
}
