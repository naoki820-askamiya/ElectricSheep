import type {
  ChatRequest,
  ChatResponse,
  CreatePlaceRequest,
  CreatePlaceResponse,
  GetPlacesResponse,
} from "@/types/api";
import { MOCK_PLACES, mockReply } from "@/lib/mock/data";

/**
 * 接続先の切り替え。.env.local の NEXT_PUBLIC_API_MODE で決める。
 *
 *   mock    … 通信せず固定の返事を返す（初期値。誰の実装も待たずに動く）
 *   self    … このアプリ内の /api/chat が Gemini を呼ぶ（本物のAIと喋れる）
 *   backend … よしたかのサーバーに繋ぐ
 */
export type ApiMode = "mock" | "self" | "backend";

const RAW_MODE = process.env.NEXT_PUBLIC_API_MODE;
export const apiMode: ApiMode =
  RAW_MODE === "self" || RAW_MODE === "backend" ? RAW_MODE : "mock";

/** backend モードのときの接続先。self モードでは同じサーバーなので空でよい */
const API_BASE_URL =
  apiMode === "backend" ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? "") : "";

/** モックモードかどうか */
export const isMockMode = apiMode === "mock";

/** 画面に出す接続先の名前 */
export const apiModeLabel: Record<ApiMode, string> = {
  mock: "モックモード",
  self: "Gemini接続",
  backend: "API接続中",
};

/** モックのときに「通信してる感」を出すための待ち時間 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch の共通処理。エラーを分かりやすい例外に変換する */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    const body = await res.text();
    // サーバーは { error: "..." } を返すので、読める文言だけを取り出す
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message) throw e;
    }
    throw new Error(`API ${res.status} ${path}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */

/** 対話：ユーザーの発言を送ってAIの返答をもらう */
export async function postChat(body: ChatRequest): Promise<ChatResponse> {
  if (isMockMode) {
    await sleep(600);
    return mockReply(body.message);
  }

  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 訪れた場所の一覧を取得 */
export async function getPlaces(userId: string): Promise<GetPlacesResponse> {
  if (isMockMode) {
    await sleep(300);
    return { places: MOCK_PLACES };
  }

  return request<GetPlacesResponse>(
    `/api/places?userId=${encodeURIComponent(userId)}`,
  );
}

/** 場所を「訪れた」として保存 */
export async function createPlace(
  body: CreatePlaceRequest,
): Promise<CreatePlaceResponse> {
  if (isMockMode) {
    await sleep(300);
    return {
      place: {
        id: `place-${Date.now()}`,
        name: body.name,
        location: body.location,
        memory: body.memory,
        visitedAt: new Date().toISOString(),
      },
    };
  }

  return request<CreatePlaceResponse>("/api/places", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
