import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase'; // firebase.tsでエクスポートしている想定


// 実際に訪れた場所と思い出を登録する関数
export const createVisit = async (
  placeId: string,
  companions: string[],
  conversationSummary: string,
  mood: string,
  isDetour: boolean,
  notableEvent: string
): Promise<string> => {
  const visitsRef = collection(db, 'visits');
  
  const newVisit = {
    placeId,
    companions,
    conversationSummary, // 会話の要約を保存
    mood,                // 気分を保存
    isDetour,
    notableEvent,
    visitedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  };

  const docRef = await addDoc(visitsRef, newVisit);
  return docRef.id;
};