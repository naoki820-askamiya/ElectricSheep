import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  writeBatch,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type {
  LatLng,
  PlaceMentionIntent,
  PlaceMentionRecord,
} from "@/types/api";

export const DEFAULT_USER_ID = "default_user";

export type SavePlaceMentionInput = {
  placeName: string;
  intent: PlaceMentionIntent;
  originalUtterance: string;
  summary: string;
  companions?: string[];
  mood?: string;
  isDetour?: boolean;
  currentLocation?: LatLng;
  userId?: string;
};

export function normalizePlaceName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Live APIが抽出した場所発言をイベントとして保存し、場所マスタにも反映する。
 * 座標は「発言時の現在地」であり、発言した目的地の座標とは限らないため別名で保持する。
 */
export async function savePlaceMention(
  input: SavePlaceMentionInput,
): Promise<PlaceMentionRecord> {
  const userId = input.userId ?? DEFAULT_USER_ID;
  const placeName = input.placeName.trim();
  const normalizedName = normalizePlaceName(placeName);
  if (!normalizedName) throw new Error("場所名が空です");

  const places = collection(db, "users", userId, "places");
  const records = collection(db, "users", userId, "placeMentions");
  let existing = await getDocs(
    query(places, where("normalizedName", "==", normalizedName), limit(1)),
  );
  // 既存データにはnormalizedNameがないものもあるため、完全一致の名前でも名寄せする。
  if (existing.empty) {
    existing = await getDocs(
      query(places, where("name", "==", placeName), limit(1)),
    );
  }
  const existingData = existing.empty ? undefined : existing.docs[0].data();
  const placeRef = existing.empty ? doc(places) : existing.docs[0].ref;
  const recordRef = doc(records);
  const recordedAt = new Date().toISOString();
  const isWishlist =
    existingData?.isWishlist === true ||
    input.intent === "wishlist" ||
    input.intent === "destination";

  const batch = writeBatch(db);
  batch.set(
    placeRef,
    {
      name: placeName,
      normalizedName,
      isWishlist,
      isFavorite: existingData?.isFavorite ?? false,
      visitCount: existingData?.visitCount ?? 0,
      lastVisitedAt: existingData?.lastVisitedAt ?? null,
      lastMentionedAt: serverTimestamp(),
      createdAt: existingData?.createdAt ?? serverTimestamp(),
      ...(existing.empty ? { lat: null, lng: null } : {}),
    },
    { merge: true },
  );
  batch.set(recordRef, {
    placeId: placeRef.id,
    placeName,
    normalizedName,
    intent: input.intent,
    originalUtterance: input.originalUtterance.trim(),
    summary: input.summary.trim(),
    companions: input.companions ?? [],
    mood: input.mood?.trim() ?? "",
    isDetour: input.isDetour ?? false,
    currentLat: input.currentLocation?.lat ?? null,
    currentLng: input.currentLocation?.lng ?? null,
    source: "gemini-live",
    createdAt: serverTimestamp(),
  });
  await batch.commit();

  return {
    id: recordRef.id,
    placeId: placeRef.id,
    placeName,
    intent: input.intent,
    originalUtterance: input.originalUtterance.trim(),
    summary: input.summary.trim(),
    companions: input.companions ?? [],
    mood: input.mood?.trim(),
    isDetour: input.isDetour ?? false,
    currentLocation: input.currentLocation,
    recordedAt,
  };
}
