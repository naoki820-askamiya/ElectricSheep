"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { subscribeNever } from "@/lib/browser";
import {
  containsWakeWord,
  createRecognition,
  isRecognitionSupported,
  isSynthesisSupported,
  speak,
  stopSpeaking,
  stripWakeWord,
} from "@/lib/speech";

/**
 * 音声対話の状態機械。
 *
 *   停止中 ──開始──→ 待機 ──「パッセン」──→ 聞き取り
 *                     ↑                        │ 沈黙
 *                     └── 応答 ←── 処理 ←──────┘
 *
 * 重要な決まりごとが2つある。
 *  1. 応答中はマイクを必ず止める。止めないとAIの声を自分で聞き取ってしまい、
 *     延々と喋り続けるハウリングが起きる。
 *  2. 停止中は一切録音しない。プライバシー方針で「ユーザーが停止できること」が
 *     求められているため、この状態は必須。
 */
export type VoicePhase =
  | "off" // 停止中（録音していない）
  | "idle" // 待機中（ウェイクワードを待っている）
  | "listening" // 聞き取り中
  | "thinking" // 処理中
  | "speaking"; // 応答中

/** 喋り終わったと判断するまでの無音時間（ミリ秒） */
const SILENCE_MS = 1400;


export type VoiceAgentOptions = {
  /** 聞き取った内容を渡すと、読み上げるべき返答を返す */
  onUserSpeech: (text: string) => Promise<string>;
};

export function useVoiceAgent({ onUserSpeech }: VoiceAgentOptions) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [interim, setInterim] = useState(""); // 認識中の途中経過
  const [error, setError] = useState<string | null>(null);

  // ブラウザ機能の有無はサーバー側では判定できない。
  // useSyncExternalStore を使うと、効果の中で setState せずに
  // サーバー用の値とクライアント用の値を出し分けられる。
  const supported = useSyncExternalStore(
    subscribeNever,
    () => isRecognitionSupported() && isSynthesisSupported(),
    () => true, // サーバー描画時は対応ありとみなす（警告の一瞬の表示を防ぐ）
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const runningRef = useRef(false); // 認識エンジンが動作中か
  const phaseRef = useRef<VoicePhase>("off"); // コールバックから最新の状態を読むため
  const bufferRef = useRef(""); // 聞き取り中の確定テキスト
  const silenceTimerRef = useRef<number | null>(null);
  const onUserSpeechRef = useRef(onUserSpeech);

  useEffect(() => {
    onUserSpeechRef.current = onUserSpeech;
  }, [onUserSpeech]);

  const setPhaseBoth = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);


  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  /** 認識エンジンを開始する。二重起動すると例外になるので必ずここを通す */
  const startRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || runningRef.current) return;
    try {
      recognition.start();
      runningRef.current = true;
    } catch {
      // すでに起動済みだった場合。状態を実態に合わせるだけでよい
      runningRef.current = true;
    }
  }, []);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || !runningRef.current) return;
    runningRef.current = false;
    try {
      recognition.stop();
    } catch {
      // 停止済み。無視してよい
    }
  }, []);

  /** 聞き取った文をAIに渡し、返答を読み上げ、待機に戻るまでの一連の流れ */
  const handleUtterance = useCallback(
    async (text: string) => {
      clearSilenceTimer();
      bufferRef.current = "";
      setInterim("");

      if (!text.trim()) {
        setPhaseBoth("idle");
        return;
      }

      // ハウリング防止。返答を喋る前に必ずマイクを止める
      stopRecognition();
      setPhaseBoth("thinking");

      try {
        const reply = await onUserSpeechRef.current(text);
        setPhaseBoth("speaking");
        await speak(reply);
      } catch (e) {
        setError(e instanceof Error ? e.message : "応答に失敗しました");
      } finally {
        // 停止操作をされていなければ待機に戻す
        if (phaseRef.current !== "off") {
          setPhaseBoth("idle");
          startRecognition();
        }
      }
    },
    [clearSilenceTimer, setPhaseBoth, startRecognition, stopRecognition],
  );

  /* 認識エンジンの組み立て。マウント時に一度だけ行う */
  useEffect(() => {
    const recognition = createRecognition();
    if (!recognition) return;
    recognitionRef.current = recognition;

    recognition.onresult = (event) => {
      const current = phaseRef.current;
      if (current !== "idle" && current !== "listening") return;

      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      // 待機中はウェイクワードだけを探す
      if (current === "idle") {
        const heard = finalText + interimText;
        if (!containsWakeWord(heard)) return;

        // 「パッセン、海に行きたい」と続けて言われた場合は後半を本文として拾う
        const rest = stripWakeWord(heard);
        bufferRef.current = rest;
        setInterim(rest);
        setPhaseBoth("listening");

        clearSilenceTimer();
        silenceTimerRef.current = window.setTimeout(() => {
          void handleUtterance(bufferRef.current);
        }, SILENCE_MS);
        return;
      }

      // 聞き取り中は喋った内容を溜める
      if (finalText) bufferRef.current += finalText;
      setInterim(bufferRef.current + interimText);

      // 新しい音が来るたびに無音タイマーを引き直す
      clearSilenceTimer();
      silenceTimerRef.current = window.setTimeout(() => {
        void handleUtterance(bufferRef.current);
      }, SILENCE_MS);
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("マイクの使用が許可されていません。ブラウザの設定を確認してください");
        runningRef.current = false;
        setPhaseBoth("off");
        return;
      }
      // no-speech / aborted は通常運転で頻繁に起きるので無視してよい
    };

    recognition.onend = () => {
      runningRef.current = false;
      // 待機・聞き取り中に勝手に止まったら繋ぎ直す（一定時間で自動停止するため）
      const current = phaseRef.current;
      if (current === "idle" || current === "listening") startRecognition();
    };

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // すでに停止している
      }
      runningRef.current = false;
    };
  }, [clearSilenceTimer, handleUtterance, setPhaseBoth, startRecognition]);

  /** 録音を開始する。ブラウザの制約でユーザー操作から呼ぶ必要がある */
  const start = useCallback(() => {
    setError(null);
    setPhaseBoth("idle");
    startRecognition();
  }, [setPhaseBoth, startRecognition]);

  /** 録音を完全に停止する（プライバシー要件） */
  const stop = useCallback(() => {
    clearSilenceTimer();
    bufferRef.current = "";
    setInterim("");
    setPhaseBoth("off");
    stopRecognition();
    stopSpeaking();
  }, [clearSilenceTimer, setPhaseBoth, stopRecognition]);

  useEffect(() => clearSilenceTimer, [clearSilenceTimer]);

  return { phase, interim, error, supported, start, stop };
}
