import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください`);
  }
  return parsed;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の数で指定してください`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません");
  }

  const dbMode = env.PASSEN_DB_MODE?.trim() || "firestore";
  if (!new Set(["firestore", "memory"]).has(dbMode)) {
    throw new Error("PASSEN_DB_MODE は firestore または memory を指定してください");
  }

  return {
    host: env.PASSEN_BACKEND_HOST?.trim() || "0.0.0.0",
    port: positiveInteger(env.PASSEN_BACKEND_PORT, 8080, "PASSEN_BACKEND_PORT"),
    geminiApiKey,
    geminiModel:
      env.GEMINI_LIVE_MODEL?.trim() || "gemini-3.1-flash-live-preview",
    geminiVoice: env.GEMINI_LIVE_VOICE?.trim() || "Kore",
    conversationIdleMs: positiveInteger(
      env.PASSEN_CONVERSATION_IDLE_MS,
      180_000,
      "PASSEN_CONVERSATION_IDLE_MS",
    ),
    locationTimeoutMs: positiveInteger(
      env.PASSEN_LOCATION_TIMEOUT_MS,
      15_000,
      "PASSEN_LOCATION_TIMEOUT_MS",
    ),
    nearbyRadiusMeters: positiveNumber(
      env.PASSEN_NEARBY_RADIUS_METERS,
      100,
      "PASSEN_NEARBY_RADIUS_METERS",
    ),
    firebaseProjectId:
      env.FIREBASE_PROJECT_ID?.trim() || "hakkason-database",
    firestoreUserIdOverride:
      env.PASSEN_FIRESTORE_USER_ID?.trim() || null,
    dbMode,
    deviceToken: env.PASSEN_DEVICE_TOKEN?.trim() || null,
    // 発表デモ用の架空データ。memory モードのときだけ読み込む
    seedFile: env.PASSEN_SEED_FILE?.trim() || null,
  };
}
