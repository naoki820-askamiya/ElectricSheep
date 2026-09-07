import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";

const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";

/**
 * ブラウザから Gemini Live API に直接接続するための短命トークンを発行する。
 * 長寿命の GEMINI_API_KEY はこの Route Handler の外へ出さない。
 */
export async function POST(): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY が設定されていません" },
      { status: 500 },
    );
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "v1beta" },
    });
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        liveConnectConstraints: { model: LIVE_MODEL },
      },
    });

    if (!token.name) {
      throw new Error("Gemini からトークンが返りませんでした");
    }

    return Response.json(
      { token: token.name, model: LIVE_MODEL },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Live APIトークンの発行に失敗しました",
      },
      { status: 502 },
    );
  }
}
