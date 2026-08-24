// Firestore CRUD関数の参考実装。device/firestore_client.py と同じスキーマ・同じ役割分担。
// docs/schema.md のコレクション構成に対応している。

import {
  collection,
  doc,
  addDoc,
  runTransaction,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

const DEFAULT_USER_ID = "default_user"; // Firebase Auth導入までの仮のユーザーID

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

function placesRef(userId: string = DEFAULT_USER_ID) {
  return collection(db, "users", userId, "places");
}

function visitsRef(userId: string = DEFAULT_USER_ID) {
  return collection(db, "users", userId, "visits");
}

export async function addPlace(
  name: string,
  lat: number,
  lng: number,
  isFavorite = false,
  isWishlist = false,
  userId: string = DEFAULT_USER_ID
): Promise<string> {
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

export async function addVisit(
  placeId: string,
  options: {
    companions?: string[];
    conversationSummary?: string;
    mood?: string;
    isDetour?: boolean;
    notableEvent?: string;
  } = {},
  userId: string = DEFAULT_USER_ID
): Promise<string> {
  const visitDocRef = doc(visitsRef(userId));
  const placeDocRef = doc(placesRef(userId), placeId);

  await runTransaction(db, async (transaction) => {
    const placeSnapshot = await transaction.get(placeDocRef);
    const currentCount = (placeSnapshot.data()?.visitCount as number) ?? 0;

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

export async function getWishlist(userId: string = DEFAULT_USER_ID): Promise<Place[]> {
  const snapshot = await getDocs(query(placesRef(userId), where("isWishlist", "==", true)));
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Place));
}

export async function getFavorites(userId: string = DEFAULT_USER_ID): Promise<Place[]> {
  const snapshot = await getDocs(query(placesRef(userId), where("isFavorite", "==", true)));
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Place));
}

export async function getVisitsForPlace(
  placeId: string,
  userId: string = DEFAULT_USER_ID
): Promise<Visit[]> {
  const snapshot = await getDocs(
    query(visitsRef(userId), where("placeId", "==", placeId), orderBy("visitedAt"))
  );
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Visit));
}

// 2点間の距離(メートル)。GPS座標同士の近さ判定に使う。
function haversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nominatim(OpenStreetMap)で座標から地名を逆引きする。
// 利用ポリシー上、呼び出し頻度は「新しい場所を見つけたときだけ」など低頻度に抑えること。
async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&namedetails=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Nominatim request failed: ${res.status}`);
  }
  const data = await res.json();
  // 施設名が取れればそれを、取れなければ住所表記の先頭部分を地名として使う
  return data?.namedetails?.name ?? data?.display_name?.split(",")[0] ?? "名称未設定の場所";
}

// 現在地の近くに登録済みの場所があればそのIDを返し、なければNominatimで地名を調べて新規登録する。
export async function findOrCreatePlace(
  lat: number,
  lng: number,
  userId: string = DEFAULT_USER_ID,
  radiusMeters = 100
): Promise<string> {
  const snapshot = await getDocs(placesRef(userId));
  for (const d of snapshot.docs) {
    const place = d.data() as Place;
    if (haversineDistanceMeters(lat, lng, place.lat, place.lng) <= radiusMeters) {
      return d.id;
    }
  }

  const name = await reverseGeocode(lat, lng);
  return addPlace(name, lat, lng);
}
