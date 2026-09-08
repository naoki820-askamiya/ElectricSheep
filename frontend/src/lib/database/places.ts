import { DocumentData } from 'firebase/firestore';
import { Place } from '../../types/database';

// Firestoreのデータを画面用の型(ISO文字列)へ変換する
export const convertToPlace = (id: string, data: DocumentData): Place => {
  return {
    id,
    name: data.name,
    location: {
      lat: data.lat,
      lng: data.lng,
    },
    isFavorite: data.isFavorite || false,
    isWishlist: data.isWishlist || false,
    visitCount: data.visitCount || 0,
    lastVisitedAt: data.lastVisitedAt ? data.lastVisitedAt.toDate().toISOString() : null,
    createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
  };
};

import { collection, addDoc, doc, updateDoc, increment, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

// 場所を新規登録する関数
export const createPlace = async (
  name: string,
  lat: number,
  lng: number
): Promise<string> => {
  const placesRef = collection(db, 'places');
  const newPlace = {
    name,
    lat, // Firestore側のフラットな設計に合わせる
    lng,
    isFavorite: false,
    isWishlist: false,
    visitCount: 0,
    lastVisitedAt: null,
    createdAt: serverTimestamp(),
  };

  const docRef = await addDoc(placesRef, newPlace);
  return docRef.id;
};

// 訪問時にPlaceの訪問回数と最終訪問日時を更新する関数
export const updatePlaceAfterVisit = async (placeId: string): Promise<void> => {
  const placeRef = doc(db, 'places', placeId);
  await updateDoc(placeRef, {
    visitCount: increment(1), // 訪問回数を+1する
    lastVisitedAt: serverTimestamp(), // 最終訪問日時を更新
  });
};