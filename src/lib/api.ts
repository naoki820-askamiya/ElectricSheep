import type { ChatRequest, ChatResponse } from "@/types/api";

/**
 * 対話APIの接続先。既定ではこのNext.jsアプリの /api/chat を使い、
 * backend の場合だけ NEXT_PUBLIC_API_BASE_URL の外部サーバーへ接続する。
 */
export type ApiMode = "self" | "backend";

export const apiMode: ApiMode =
  process.env.NEXT_PUBLIC_API_MODE === "backend" ? "backend" : "self";

const API_BASE_URL =
  apiMode === "backend" ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? "") : "";

export const apiModeLabel: Record<ApiMode, string> = {
  self: "Gemini接続",
  backend: "API接続中",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = await response.text();
    let message: string | undefined;
    try {
      const parsed = JSON.parse(body) as {
        error?: string | { message?: string };
      };
      message =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message;
    } catch {
      // JSON以外のエラー本文は、下の共通メッセージへ含める。
    }
    if (message) throw new Error(message);
    throw new Error(`API ${response.status} ${path}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

export async function postChat(body: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
