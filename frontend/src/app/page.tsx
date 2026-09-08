"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiMode, apiModeLabel, postChat } from "@/lib/api";
import { MOCK_USER_ID } from "@/lib/mock/data";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useVoiceAgent, type VoicePhase } from "@/hooks/useVoiceAgent";
import type { Message } from "@/types/api";
import { Place } from '@/types/database';

/** 各状態の見せ方。運転中に一目で分かることを優先する */
const PHASE_LABEL: Record<VoicePhase, string> = {
  off: "停止中",
  idle: "「パッセン」と呼びかけてください",
  listening: "聞いています",
  thinking: "考えています",
  speaking: "お話ししています",
};

/** AIに送る会話履歴の長さ。増やすほど文脈は続くが、無料枠の消費も増える */
const HISTORY_TURNS = 10;

const PHASE_COLOR: Record<VoicePhase, string> = {
  off: "bg-black/20 dark:bg-white/20",
  idle: "bg-black/30 dark:bg-white/30",
  listening: "bg-blue-600",
  thinking: "bg-amber-500",
  speaking: "bg-emerald-600",
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

  const voice = useVoiceAgent({ onUserSpeech: send });

  async function handleSendFromInput() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await send(text);
  }

  const listening = voice.phase !== "off";

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col p-4">
      <header className="flex items-baseline justify-between gap-4 border-b border-black/10 pb-3 dark:border-white/15">
        <h1 className="text-2xl font-semibold tracking-tight">パッセン</h1>
        <p className="text-xs text-black/50 dark:text-white/50">
          {apiModeLabel[apiMode]}
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
        <button
          onClick={listening ? voice.stop : voice.start}
          disabled={!voice.supported}
          className={`shrink-0 rounded-full px-6 py-3 text-base font-medium disabled:opacity-40 ${
            listening
              ? "bg-red-600 text-white"
              : "bg-blue-600 text-white"
          }`}
        >
          {listening ? "録音を停止" : "音声をはじめる"}
        </button>
      </section>

      {!voice.supported && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          このブラウザは音声機能に対応していません。Chrome または Edge で開いてください。
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
            {suggested.name && (
              <p className="text-sm text-black/60 dark:text-white/60">
                {suggested.name}
              </p>
            )}
            {/* TODO: 地図画面ができたらここから遷移させる */}
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      {/*
        開発用の入力欄。本番では消す。
        音声が不調なときにキーボードで動作確認できないと開発が進まないので残してある。
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
