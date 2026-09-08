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
  getDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db, currentUserId } from "./firebase";

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

function placesRef(userId: string) {
  return collection(db, "users", userId, "places");
}

function visitsRef(userId: string) {
  return collection(db, "users", userId, "visits");
}

export async function addPlace(
  name: string,
  lat: number,
  lng: number,
  isFavorite = false,
  isWishlist = false,
  userId?: string
): Promise<string> {
  const uid = userId ?? (await currentUserId);
  const docRef = await addDoc(placesRef(uid), {
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
  userId?: string
): Promise<string> {
  const uid = userId ?? (await currentUserId);
  const visitDocRef = doc(visitsRef(uid));
  const placeDocRef = doc(placesRef(uid), placeId);

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

export async function getWishlist(userId?: string): Promise<Place[]> {
  const uid = userId ?? (await currentUserId);
  const snapshot = await getDocs(query(placesRef(uid), where("isWishlist", "==", true)));
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Place));
}

export async function getFavorites(userId?: string): Promise<Place[]> {
  const uid = userId ?? (await currentUserId);
  const snapshot = await getDocs(query(placesRef(uid), where("isFavorite", "==", true)));
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Place));
}

export async function getVisitsForPlace(
  placeId: string,
  userId?: string
): Promise<Visit[]> {
  const uid = userId ?? (await currentUserId);
  const snapshot = await getDocs(
    query(visitsRef(uid), where("placeId", "==", placeId), orderBy("visitedAt"))
  );
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Visit));
}

export type VisitWithPlace = Visit & { place: Place | null };

// 「N年前の今日」の訪問記録を、場所情報付きで取得する。
// タイムゾーンの誤差や「ちょうど当日」に限らず前後で会話が起きうることを考慮し、
// 対象日の前後windowDays日を範囲に含める。
export async function getMemoriesOnThisDay(
  userId?: string,
  yearsAgo = 1,
  windowDays = 1
): Promise<VisitWithPlace[]> {
  const uid = userId ?? (await currentUserId);

  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setFullYear(target.getFullYear() - yearsAgo);

  const start = new Date(target);
  start.setDate(start.getDate() - windowDays);

  const end = new Date(target);
  end.setDate(end.getDate() + windowDays + 1);

  const snapshot = await getDocs(
    query(
      visitsRef(uid),
      where("visitedAt", ">=", Timestamp.fromDate(start)),
      where("visitedAt", "<", Timestamp.fromDate(end)),
      orderBy("visitedAt")
    )
  );
  const visits = snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Visit));

  return Promise.all(
    visits.map(async (visit) => {
      const placeSnap = await getDoc(doc(placesRef(uid), visit.placeId));
      const place = placeSnap.exists() ? ({ id: placeSnap.id, ...placeSnap.data() } as Place) : null;
      return { ...visit, place };
    })
  );
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
  userId?: string,
  radiusMeters = 100
): Promise<string> {
  const uid = userId ?? (await currentUserId);
  const snapshot = await getDocs(placesRef(uid));
  for (const d of snapshot.docs) {
    const place = d.data() as Place;
    if (haversineDistanceMeters(lat, lng, place.lat, place.lng) <= radiusMeters) {
      return d.id;
    }
  }

  const name = await reverseGeocode(lat, lng);
  return addPlace(name, lat, lng, false, false, uid);
}
