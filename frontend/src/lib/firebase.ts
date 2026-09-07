import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from "firebase/firestore";

// FirebaseのWeb設定値は秘密鍵ではない。デプロイ先を差し替えられるようenvを優先する。
const firebaseConfig = {
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

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function createFirestore(): Firestore {
  if (typeof window === "undefined") return getFirestore(app);

  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager(undefined),
      }),
    });
  } catch {
    // HMRなどですでに初期化済みなら既存インスタンスを利用する。
    return getFirestore(app);
  }
}

export const db = createFirestore();
