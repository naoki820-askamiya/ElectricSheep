import "client-only";

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";

/**
 * Firebase の Web 設定値は秘密鍵ではありません。
 * 既存プロジェクトへ設定なしでも接続できる既定値を残しつつ、
 * デプロイ先ごとに NEXT_PUBLIC_FIREBASE_* で上書きできます。
 */
export const firebaseConfig = {
  apiKey:
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??
    "AIzaSyAuB5_yZu-47dLEw1__AtLZjBJbSrdwuWc",
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
    "hakkason-database.firebaseapp.com",
  projectId:
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "hakkason-database",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    "hakkason-database.firebasestorage.app",
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "410396967219",
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ??
    "1:410396967219:web:98139289f0f49284c3fe46",
};

export const firebaseApp =
  getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

function createFirestore(): Firestore {
  try {
    // IndexedDB に保持し、オフライン時の読み書きを通信復帰後に同期する。
    // 複数タブで開いてもキャッシュ所有権が競合しない構成にしている。
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    // Fast Refresh などで既に初期化済みなら、同じインスタンスを再利用する。
    return getFirestore(firebaseApp);
  }
}

export const db = createFirestore();
