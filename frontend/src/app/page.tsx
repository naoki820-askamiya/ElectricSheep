"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postChat } from "@/lib/api";
import { MOCK_USER_ID } from "@/lib/mock/data";
import { useGeolocation } from "@/hooks/useGeolocation";
import {
  useGeminiLiveAgent,
  type GeminiLivePhase,
} from "@/hooks/useGeminiLiveAgent";
import type {
  Message,
  Place,
  PlaceMentionIntent,
  PlaceMentionRecord,
} from "@/types/api";

/** 各状態の見せ方。運転中に一目で分かることを優先する */
const PHASE_LABEL: Record<GeminiLivePhase, string> = {
  off: "停止中",
  waiting: "「パッセン」と呼びかけてください",
  connecting: "Gemini Live に接続しています",
  listening: "聞いています",
  speaking: "お話ししています",
  saving: "場所を記録しています",
};

/** AIに送る会話履歴の長さ。増やすほど文脈は続くが、無料枠の消費も増える */
const HISTORY_TURNS = 10;

const PHASE_COLOR: Record<GeminiLivePhase, string> = {
  off: "bg-black/20 dark:bg-white/20",
  waiting: "bg-black/30 dark:bg-white/30",
  connecting: "bg-amber-500",
  listening: "bg-blue-600",
  speaking: "bg-emerald-600",
  saving: "bg-violet-600",
};

const INTENT_LABEL: Record<PlaceMentionIntent, string> = {
  destination: "今回の行き先",
  wishlist: "行きたい場所",
  visited: "訪れた場所",
  memory: "場所の思い出",
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "greeting",
      role: "assistant",
      content: "おかえりなさい。今日は、どこへ行きましょうか。",
      createdAt: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Place | null>(null);
  const [savedPlaces, setSavedPlaces] = useState<PlaceMentionRecord[]>([]);

  const { location } = useGeolocation();
  const bottomRef = useRef<HTMLDivElement>(null);

  // send() を作り直さずに最新の履歴を読むための控え。
  // messages を直接使うと send が毎回作り直され、音声側の登録がずれる。
  const messagesRef = useRef<Message[]>(messages);

  useEffect(() => {
    messagesRef.current = messages;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * 発言を1往復ぶん処理する。音声・テキストのどちらから来ても同じ道を通る。
   * 音声側には読み上げる文字列を返す必要がある。
   */
  const send = useCallback(
    async (text: string): Promise<string> => {
      const trimmed = text.trim();
      if (!trimmed) return "";

      // 送信前の履歴を控えておく（setMessages は非同期に反映されるため）
      const history = messagesRef.current;

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: trimmed,
          createdAt: new Date().toISOString(),
        },
      ]);
      setSending(true);
      setError(null);

      try {
        const res = await postChat({
          userId: MOCK_USER_ID,
          message: trimmed,
          currentLocation: location ?? undefined,
          // 長くなりすぎないよう直近の数往復だけ送る
          history: history.slice(-HISTORY_TURNS),
        });

        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: res.reply,
            createdAt: new Date().toISOString(),
          },
        ]);
        setSuggested(res.suggestedPlace ?? null);
        return res.reply;
      } catch (e) {
        const message = e instanceof Error ? e.message : "通信に失敗しました";
        setError(message);
        return "すみません、うまく聞き取れませんでした。もう一度お願いします。";
      } finally {
        setSending(false);
      }
    },
    [location],
  );

  const handleLiveTurn = useCallback(
    (userText: string, assistantText: string) => {
      const now = Date.now();
      setMessages((previous) => [
        ...previous,
        ...(userText
          ? [
              {
                id: `live-user-${now}`,
                role: "user" as const,
                content: userText,
                createdAt: new Date().toISOString(),
              },
            ]
          : []),
        ...(assistantText
          ? [
              {
                id: `live-assistant-${now}`,
                role: "assistant" as const,
                content: assistantText,
                createdAt: new Date().toISOString(),
              },
            ]
          : []),
      ]);
    },
    [],
  );

  const handlePlaceSaved = useCallback((record: PlaceMentionRecord) => {
    setSavedPlaces((previous) => [record, ...previous].slice(0, 5));
  }, []);

  const voice = useGeminiLiveAgent({
    currentLocation: location ?? undefined,
    userId: MOCK_USER_ID,
    onTurn: handleLiveTurn,
    onPlaceSaved: handlePlaceSaved,
  });

  async function handleSendFromInput() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    if (voice.sendText(text)) return;
    await send(text);
  }

  const listening = voice.phase !== "off";

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col p-4">
      <header className="flex items-baseline justify-between gap-4 border-b border-black/10 pb-3 dark:border-white/15">
        <h1 className="text-2xl font-semibold tracking-tight">パッセン</h1>
        <p className="text-xs text-black/50 dark:text-white/50">
          Gemini Live / Firestore
          {location
            ? ` / ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
            : " / 位置情報なし"}
        </p>
      </header>

      {/* 音声の状態表示。運転中に見る唯一の情報なので大きく出す */}
      <section className="flex items-center gap-4 border-b border-black/10 py-5 dark:border-white/15">
        <span
          className={`h-4 w-4 shrink-0 rounded-full ${PHASE_COLOR[voice.phase]} ${
            voice.phase === "listening" ? "animate-pulse" : ""
          }`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-xl font-medium" aria-live="polite">
            {PHASE_LABEL[voice.phase]}
          </p>
          {voice.interim && (
            <p className="truncate text-base text-black/50 dark:text-white/50">
              {voice.interim}
            </p>
          )}
        </div>

        {/* 録音の開始・停止。プライバシー方針で停止手段が必須 */}
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          {voice.phase === "waiting" && (
            <button
              onClick={voice.startNow}
              className="rounded-full border border-blue-600 px-5 py-2.5 text-sm font-medium text-blue-700 dark:text-blue-300"
            >
              今すぐ会話
            </button>
          )}
          <button
            onClick={listening ? voice.stop : voice.start}
            disabled={!voice.supported}
            className={`rounded-full px-6 py-3 text-base font-medium disabled:opacity-40 ${
              listening
                ? "bg-red-600 text-white"
                : "bg-blue-600 text-white"
            }`}
          >
            {listening ? "録音を停止" : "音声をはじめる"}
          </button>
        </div>
      </section>

      {!voice.supported && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          このブラウザはマイク音声のストリーミングに対応していません。
        </p>
      )}

      {voice.supported && !voice.wakeWordSupported && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          このブラウザではウェイクワード検出を使えないため、「音声をはじめる」で直接会話を開始します。
        </p>
      )}

      {voice.error && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600">
          {voice.error}
        </p>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto py-6">
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <p
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-5 py-3 text-lg leading-relaxed ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-black/5 dark:bg-white/10"
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}

        {sending && (
          <p className="text-sm text-black/40 dark:text-white/40">考えています…</p>
        )}

        {suggested && (
          <div className="rounded-2xl border border-blue-600/30 bg-blue-600/5 p-4">
            <p className="text-sm text-black/60 dark:text-white/60">行き先の提案</p>
            <p className="mt-1 text-xl font-medium">{suggested.name}</p>
            {suggested.address && (
              <p className="text-sm text-black/60 dark:text-white/60">
                {suggested.address}
              </p>
            )}
            {/* TODO: 地図画面ができたらここから遷移させる */}
          </div>
        )}

        {savedPlaces.map((record) => (
          <div
            key={record.id}
            className="rounded-2xl border border-violet-600/30 bg-violet-600/5 p-4"
          >
            <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
              Firestoreに記録しました・{INTENT_LABEL[record.intent]}
            </p>
            <p className="mt-1 text-xl font-medium">{record.placeName}</p>
            <p className="mt-1 text-sm text-black/60 dark:text-white/60">
              {record.summary}
            </p>
          </div>
        ))}

        {error && (
          <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      {/*
        開発・アクセシビリティ用の入力欄。Live接続中は同じ会話へ送り、
        未接続時は従来の /api/chat を使う。
      */}
      <div className="flex gap-2 border-t border-black/10 pt-4 dark:border-white/15">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              void handleSendFromInput();
            }
          }}
          placeholder="開発用：キーボードでも試せます"
          className="flex-1 rounded-full border border-black/15 bg-transparent px-5 py-3 text-lg outline-none focus:border-blue-600 dark:border-white/20"
        />
        <button
          onClick={() => void handleSendFromInput()}
          disabled={sending || !input.trim()}
          className="rounded-full bg-black/70 px-6 py-3 text-lg font-medium text-white disabled:opacity-40 dark:bg-white/70 dark:text-black"
        >
          送信
        </button>
      </div>
    </main>
  );
}
