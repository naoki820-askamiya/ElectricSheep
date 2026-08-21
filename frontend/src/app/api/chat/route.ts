import type { ChatRequest, ChatResponse } from "@/types/api";

/**
 * 対話APIの暫定実装（Gemini を直接呼ぶ）。
 *
 * よしたか・なおきの実装ができるまでの繋ぎ。
 * 完成したら .env.local を NEXT_PUBLIC_API_MODE=backend に変えるだけで
 * こちらは使われなくなる。ファイルを消す必要もない。
 *
 * ■ ここがサーバー側で動くことが重要
 * APIキーは絶対にブラウザへ渡してはいけない。
 * NEXT_PUBLIC_ を付けた環境変数はブラウザのJSに埋め込まれて誰でも見られるので、
 * キーの類は必ず NEXT_PUBLIC_ を付けずに書き、この Route Handler の中でだけ読む。
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * モデル名は入れ替わりが早い。古いものは新規ユーザーに対して 404 になるため、
 * .env.local の GEMINI_MODEL で差し替えられるようにしてある。
 *
 * gemini-flash-latest という自動追従の別名もあるが、混雑時に 503 を返すことがあった。
 * デモ中に落ちると困るので、動作確認済みのモデルを直接指定している。
 * 使えるモデルの一覧はこれで確認できる:
 *   curl "https://generativelanguage.googleapis.com/v1beta/models" -H "x-goog-api-key: キー"
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";

/**
 * 主モデルが混雑で落ち続けたときの逃げ道。デモ中に無言になるのを防ぐ。
 * 実測（4回ずつ / 2026-08-17）:
 *   gemini-3.1-flash-lite  成功 4/4  平均 2.95秒  ← 主
 *   gemini-3.5-flash       成功 4/4  平均 17.1秒  ← 遅すぎるが確実なので控え
 *   gemini-3.7-flash       成功 2/4  平均 4.11秒
 */
const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash";

const SYSTEM_PROMPT = `あなたは「パッセン」という車載AIです。
高齢のユーザーが人生を振り返りながらドライブする場面で、助手席から静かに語りかけます。

守ること:
- 音声で読み上げられるので、80文字程度の短い返答にする。
- 箇条書き・記号・マークダウンは使わない。話し言葉だけで答える。
- 相手の思い出を引き出す問いかけを混ぜる。急かさない。
- 行き先を提案したときだけ suggestedPlace を埋める。雑談なら null にする。`;

/**
 * 混雑時の 503 と、レート制限の 429 は時間をおけば直ることが多い。
 * デモ中に一度の失敗で止まると困るので、短い間隔で数回だけ試し直す。
 */
const RETRY_DELAYS_MS = [600, 1500];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GeminiPart = { text?: string };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  error?: { message?: string };
};

/** 返してほしいJSONの形。指定しておくと崩れた出力が返ってこなくなる */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    suggestedPlace: {
      type: "OBJECT",
      nullable: true,
      properties: {
        name: { type: "STRING" },
        address: { type: "STRING" },
        lat: { type: "NUMBER" },
        lng: { type: "NUMBER" },
      },
    },
  },
  required: ["reply"],
};

/** LLMが返したJSONを ChatResponse に変換する。壊れていても落とさない */
function parseReply(raw: string): ChatResponse {
  try {
    const parsed = JSON.parse(raw) as {
      reply?: string;
      suggestedPlace?: {
        name?: string;
        address?: string;
        lat?: number;
        lng?: number;
      } | null;
    };

    const place = parsed.suggestedPlace;
    const hasCoords =
      place && typeof place.lat === "number" && typeof place.lng === "number";

    return {
      reply: parsed.reply?.trim() || raw.trim(),
      suggestedPlace: hasCoords
        ? {
            id: `suggest-${Date.now()}`,
            name: place.name ?? "提案された場所",
            address: place.address,
            location: { lat: place.lat as number, lng: place.lng as number },
          }
        : undefined,
    };
  } catch {
    // JSONで返ってこなかった場合は本文をそのまま読み上げる
    return { reply: raw.trim() };
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!GEMINI_API_KEY) {
    return Response.json(
      {
        error:
          "GEMINI_API_KEY が設定されていません。.env.local に追記して開発サーバーを再起動してください。",
      },
      { status: 500 },
    );
  }

  const body = (await request.json()) as ChatRequest;

  if (!body.message?.trim()) {
    return Response.json({ error: "message が空です" }, { status: 400 });
  }

  // これまでの会話を Gemini の形式に変換する
  const contents = [
    ...(body.history ?? []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: body.message }] },
  ];

  const location = body.currentLocation
    ? `\n現在地: 緯度 ${body.currentLocation.lat}, 経度 ${body.currentLocation.lng}`
    : "";

  const payload = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + location }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.9,
      // 思考トークンが出力枠を食って返答が途中で切れるため、
      // 上限を広めに取ったうえで思考を抑えている。
      // 車載で即答が要るので、考え込ませない方が体験も良い。
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  /** 1つのモデルに対して、混雑（503）とレート制限（429）の間だけ試し直す */
  async function callModel(model: string) {
    let res!: Response;
    let data: GeminiResponse = {};

    for (let attempt = 0; ; attempt += 1) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY as string,
          },
          body: payload,
        },
      );

      data = (await res.json()) as GeminiResponse;

      const transient = res.status === 503 || res.status === 429;
      if (!transient || attempt >= RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    return { res, data };
  }

  try {
    let { res, data } = await callModel(GEMINI_MODEL);

    // 主モデルが混雑で駄目なら、遅くても確実な控えに切り替える
    if (
      (res.status === 503 || res.status === 429) &&
      GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
    ) {
      ({ res, data } = await callModel(GEMINI_FALLBACK_MODEL));
    }

    if (!res.ok) {
      // モデル名の間違いや無料枠の上限はここに出る
      return Response.json(
        { error: data.error?.message ?? `Gemini API エラー (${res.status})` },
        { status: 502 },
      );
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) {
      return Response.json(
        { error: "Gemini から空の返答が返りました" },
        { status: 502 },
      );
    }

    return Response.json(parseReply(text) satisfies ChatResponse);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Gemini への接続に失敗しました" },
      { status: 502 },
    );
  }
}
