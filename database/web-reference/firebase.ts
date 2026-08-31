// Next.jsプロジェクトができたら、そのまま `src/lib/firebase.ts` などにコピーして使う想定の参考実装。
// npm install firebase が必要。

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from "firebase/firestore";

// このapiKeyは公開されても問題ない値(セキュリティはFirestoreのセキュリティルール側で担保する)
const firebaseConfig = {
  apiKey: "AIzaSyAuB5_yZu-47dLEw1__AtLZjBJbSrdwuWc",
  authDomain: "hakkason-database.firebaseapp.com",
  projectId: "hakkason-database",
  storageBucket: "hakkason-database.firebasestorage.app",
  messagingSenderId: "410396967219",
  appId: "1:410396967219:web:98139289f0f49284c3fe46",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// persistentLocalCacheでオフライン時もブラウザのIndexedDBにキャッシュし、
// 通信復帰時に自動同期する(端末側キャッシュの役割をこれが担う)
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentSingleTabManager(undefined),
  }),
});
