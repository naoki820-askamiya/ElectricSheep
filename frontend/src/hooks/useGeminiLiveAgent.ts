"use client";

import {
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { subscribeNever } from "@/lib/browser";
import { LiveMicrophone, LivePcmPlayer } from "@/lib/live-audio";
import {
  DEFAULT_USER_ID,
  savePlaceMention,
  type SavePlaceMentionInput,
} from "@/lib/place-records";
import {
  containsWakeWord,
  createRecognition,
  isRecognitionSupported,
  stripWakeWord,
} from "@/lib/speech";
import type {
  LatLng,
  PlaceMentionIntent,
  PlaceMentionRecord,
} from "@/types/api";

export type GeminiLivePhase =
  | "off"
  | "waiting"
  | "connecting"
  | "listening"
  | "speaking"
  | "saving";

type GeminiLiveAgentOptions = {
  currentLocation?: LatLng;
  userId?: string;
  onTurn?: (userText: string, assistantText: string) => void;
  onPlaceSaved?: (record: PlaceMentionRecord) => void;
};

type LiveTokenResponse = {
  token?: string;
  model?: string;
  error?: string;
};

const RECORD_PLACE_TOOL = "record_place_mention";
const PLACE_INTENTS: PlaceMentionIntent[] = [
  "destination",
  "wishlist",
  "visited",
  "memory",
];

const recordPlaceDeclaration = {
  name: RECORD_PLACE_TOOL,
  description:
    "車内の利用者が、自分の行き先・行きたい場所・訪れた場所・場所に関する思い出を明確に語り、その内容を記録すべきときだけ呼ぶ。同じ発話について一度だけ呼ぶ。単なる質問、AI側の提案、一般的な場所の話題では呼ばない。",
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      placeName: {
        type: "string",
        description: "発話に含まれる施設名・地名。推測で補わない。",
      },
      intent: {
        type: "string",
        enum: PLACE_INTENTS,
        description:
          "destination=今向かう、wishlist=いつか行きたい、visited=訪れた、memory=場所の思い出",
      },
      originalUtterance: {
        type: "string",
        description: "記録判断の根拠になった利用者の発話。意味を変えない。",
      },
      summary: {
        type: "string",
        description: "場所と意図が分かる、短い日本語の要約。",
      },
      companions: {
        type: "array",
        items: { type: "string" },
        description: "発話から明示的に分かる同行者。分からなければ空配列。",
      },
      mood: {
        type: "string",
        description: "発話から明示的に分かる気分。分からなければ空文字。",
      },
      isDetour: {
        type: "boolean",
        description: "予定外の寄り道だと明示された場合だけtrue。",
      },
    },
    required: [
      "placeName",
      "intent",
      "originalUtterance",
      "summary",
      "companions",
      "mood",
      "isDetour",
    ],
  },
};

const SYSTEM_INSTRUCTION = `あなたは車内で使う日本語の会話相手「パッセン」です。
返答は運転を邪魔しない自然な日本語で、原則1〜2文と短くしてください。
利用者の音声が不明瞭なら推測せず、短く聞き返してください。

場所の記録ルール:
- 利用者自身が「今から京都へ行く」「海に行きたい」「昨日名古屋城へ行った」「神戸は家族旅行の思い出」のように、特定できる場所と本人の意図・経験を明確に述べた場合だけ record_place_mention を呼びます。
- 単なる一般質問、ニュース、例文、AIが提案しただけの場所、「どこか行きたい」のように場所を特定できない発話では呼びません。
- 推測した場所名では呼びません。曖昧なら先に確認します。
- 同じ利用者発話についてツールを重複して呼びません。
- ツールが成功したら、何を記録したかを短く自然に伝えます。失敗したら記録できなかったと伝えます。`;

function mediaSupported(): boolean {
  if (typeof window === "undefined") return false;
  return typeof navigator.mediaDevices?.getUserMedia === "function";
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} が不正です`);
  }
  return value.trim();
}

function parsePlaceToolArgs(args: Record<string, unknown>): SavePlaceMentionInput {
  const intent = args.intent;
  if (
    typeof intent !== "string" ||
    !PLACE_INTENTS.includes(intent as PlaceMentionIntent)
  ) {
    throw new Error("intent が不正です");
  }

  return {
    placeName: requiredString(args, "placeName"),
    intent: intent as PlaceMentionIntent,
    originalUtterance: requiredString(args, "originalUtterance"),
    summary: requiredString(args, "summary"),
    companions: Array.isArray(args.companions)
      ? args.companions.filter(
          (value): value is string => typeof value === "string" && Boolean(value.trim()),
        )
      : [],
    mood: typeof args.mood === "string" ? args.mood : "",
    isDetour: args.isDetour === true,
  };
}

export function useGeminiLiveAgent({
  currentLocation,
  userId = DEFAULT_USER_ID,
  onTurn,
  onPlaceSaved,
}: GeminiLiveAgentOptions) {
  const [phase, setPhase] = useState<GeminiLivePhase>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const supported = useSyncExternalStore(
    subscribeNever,
    mediaSupported,
    () => true,
  );
  const wakeWordSupported = useSyncExternalStore(
    subscribeNever,
    isRecognitionSupported,
    () => true,
  );

  const sessionRef = useRef<Session | null>(null);
  const microphoneRef = useRef(new LiveMicrophone());
  const playerRef = useRef(new LivePcmPlayer());
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recognitionRunningRef = useRef(false);
  const wakeWantedRef = useRef(false);
  const activeRef = useRef(false);
  const connectingRef = useRef(false);
  const connectionAttemptRef = useRef(0);
  const inputTranscriptRef = useRef("");
  const outputTranscriptRef = useRef("");
  const locationRef = useRef(currentLocation);
  const userIdRef = useRef(userId);
  const onTurnRef = useRef(onTurn);
  const onPlaceSavedRef = useRef(onPlaceSaved);

  useEffect(() => {
    locationRef.current = currentLocation;
    userIdRef.current = userId;
    onTurnRef.current = onTurn;
    onPlaceSavedRef.current = onPlaceSaved;
  }, [currentLocation, onPlaceSaved, onTurn, userId]);

  const stopWakeRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || !recognitionRunningRef.current) return;
    recognitionRunningRef.current = false;
    try {
      recognition.stop();
    } catch {
      // すでに停止済み。
    }
  }, []);

  const startWakeRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || recognitionRunningRef.current) return;
    try {
      recognition.start();
      recognitionRunningRef.current = true;
    } catch {
      // start済みならonend/onstartに状態を任せる。
    }
  }, []);

  const handleToolCalls = useCallback(async (calls: FunctionCall[]) => {
    const session = sessionRef.current;
    if (!session) return;

    for (const call of calls) {
      if (call.name !== RECORD_PLACE_TOOL) {
        session.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: { error: "未対応の機能です" },
          },
        });
        continue;
      }

      setPhase("saving");
      try {
        const parsed = parsePlaceToolArgs(call.args ?? {});
        const record = await savePlaceMention({
          ...parsed,
          currentLocation: locationRef.current,
          userId: userIdRef.current,
        });
        onPlaceSavedRef.current?.(record);
        if (sessionRef.current !== session) return;
        session.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: {
              output: {
                status: "saved",
                recordId: record.id,
                placeName: record.placeName,
                intent: record.intent,
              },
            },
          },
        });
      } catch (toolError) {
        if (sessionRef.current !== session) return;
        session.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: {
              error:
                toolError instanceof Error
                  ? toolError.message
                  : "Firestoreへの保存に失敗しました",
            },
          },
        });
      }
    }
  }, []);

  const handleServerMessage = useCallback(
    (message: LiveServerMessage) => {
      if (message.data) {
        setPhase("speaking");
        void playerRef.current.enqueue(message.data);
      }

      const content = message.serverContent;
      if (content?.interrupted) {
        playerRef.current.stopQueuedAudio();
        outputTranscriptRef.current = "";
        setPhase("listening");
      }

      if (content?.inputTranscription?.text) {
        inputTranscriptRef.current += content.inputTranscription.text;
        setInterim(inputTranscriptRef.current);
      } else if (content?.interimInputTranscription?.text) {
        setInterim(
          inputTranscriptRef.current + content.interimInputTranscription.text,
        );
      }

      if (content?.outputTranscription?.text) {
        outputTranscriptRef.current += content.outputTranscription.text;
      }

      if (message.toolCall?.functionCalls?.length) {
        void handleToolCalls(message.toolCall.functionCalls);
      }

      if (content?.turnComplete) {
        const userText = inputTranscriptRef.current.trim();
        const assistantText = outputTranscriptRef.current.trim();
        if (userText || assistantText) {
          onTurnRef.current?.(userText, assistantText);
        }
        inputTranscriptRef.current = "";
        outputTranscriptRef.current = "";
        setInterim("");
        if (activeRef.current) setPhase("listening");
      }
    },
    [handleToolCalls],
  );

  const disconnectLive = useCallback(async () => {
    connectionAttemptRef.current += 1;
    activeRef.current = false;
    connectingRef.current = false;
    inputTranscriptRef.current = "";
    outputTranscriptRef.current = "";
    setInterim("");

    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      try {
        session.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        // WebSocketが閉じたあとなら送れない。
      }
      session.close();
    }
    await microphoneRef.current.stop();
    await playerRef.current.close();
  }, []);

  const connectLive = useCallback(
    async (initialText = "") => {
      if (activeRef.current || connectingRef.current) return;
      const attempt = connectionAttemptRef.current + 1;
      connectionAttemptRef.current = attempt;
      connectingRef.current = true;
      wakeWantedRef.current = false;
      stopWakeRecognition();
      setError(null);
      setInterim("");
      setPhase("connecting");

      try {
        const response = await fetch("/api/live-token", {
          method: "POST",
          cache: "no-store",
        });
        const body = (await response.json()) as LiveTokenResponse;
        if (!response.ok || !body.token || !body.model) {
          throw new Error(body.error ?? "Live APIトークンを取得できませんでした");
        }
        if (attempt !== connectionAttemptRef.current) return;

        const ai = new GoogleGenAI({
          apiKey: body.token,
          httpOptions: { apiVersion: "v1beta" },
        });
        const session = await ai.live.connect({
          model: body.model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: SYSTEM_INSTRUCTION,
            speechConfig: {
              languageCode: "ja-JP",
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ functionDeclarations: [recordPlaceDeclaration] }],
            realtimeInputConfig: {
              automaticActivityDetection: { silenceDurationMs: 700 },
            },
            contextWindowCompression: {
              triggerTokens: "12000",
              slidingWindow: { targetTokens: "6000" },
            },
          },
          callbacks: {
            onmessage: (message) => {
              if (attempt === connectionAttemptRef.current) {
                handleServerMessage(message);
              }
            },
            onerror: (event) => {
              if (attempt !== connectionAttemptRef.current) return;
              const detail =
                event.error instanceof Error
                  ? event.error.message
                  : "Gemini Live APIとの通信でエラーが発生しました";
              setError(detail);
            },
            onclose: () => {
              if (
                attempt !== connectionAttemptRef.current ||
                !activeRef.current
              ) {
                return;
              }
              activeRef.current = false;
              sessionRef.current = null;
              void microphoneRef.current.stop();
              void playerRef.current.close();
              setPhase("off");
              setError("Gemini Live APIとの接続が終了しました。もう一度開始してください");
            },
          },
        });

        if (attempt !== connectionAttemptRef.current) {
          session.close();
          return;
        }

        sessionRef.current = session;
        activeRef.current = true;
        await microphoneRef.current.start((data) => {
          sessionRef.current?.sendRealtimeInput({
            audio: { data, mimeType: "audio/pcm;rate=16000" },
          });
        });
        if (attempt !== connectionAttemptRef.current) {
          await microphoneRef.current.stop();
          return;
        }
        setPhase("listening");

        if (initialText.trim()) {
          inputTranscriptRef.current = initialText.trim();
          setInterim(initialText.trim());
          session.sendClientContent({
            turns: initialText.trim(),
            turnComplete: true,
          });
        }
      } catch (connectError) {
        if (attempt !== connectionAttemptRef.current) return;
        await disconnectLive();
        setPhase("off");
        setError(
          connectError instanceof Error
            ? connectError.message
            : "Gemini Live APIに接続できませんでした",
        );
      } finally {
        if (attempt === connectionAttemptRef.current) {
          connectingRef.current = false;
        }
      }
    },
    [disconnectLive, handleServerMessage, stopWakeRecognition],
  );

  useEffect(() => {
    const recognition = createRecognition();
    if (!recognition) return;
    recognitionRef.current = recognition;

    recognition.onstart = () => {
      recognitionRunningRef.current = true;
    };
    recognition.onresult = (event) => {
      let heard = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        heard += event.results[index][0].transcript;
      }
      if (!containsWakeWord(heard)) return;

      wakeWantedRef.current = false;
      stopWakeRecognition();
      void connectLive(stripWakeWord(heard));
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wakeWantedRef.current = false;
        setPhase("off");
        setError("マイクの使用が許可されていません。ブラウザの設定を確認してください");
        void playerRef.current.close();
      }
    };
    recognition.onend = () => {
      recognitionRunningRef.current = false;
      if (wakeWantedRef.current) startWakeRecognition();
    };

    return () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // すでに停止済み。
      }
      recognitionRunningRef.current = false;
      recognitionRef.current = null;
    };
  }, [connectLive, startWakeRecognition, stopWakeRecognition]);

  const start = useCallback(() => {
    setError(null);
    void playerRef.current.prepare();
    if (!wakeWordSupported) {
      void connectLive();
      return;
    }
    wakeWantedRef.current = true;
    setPhase("waiting");
    startWakeRecognition();
  }, [connectLive, startWakeRecognition, wakeWordSupported]);

  const startNow = useCallback(() => {
    setError(null);
    void playerRef.current.prepare();
    wakeWantedRef.current = false;
    stopWakeRecognition();
    void connectLive();
  }, [connectLive, stopWakeRecognition]);

  const stop = useCallback(() => {
    wakeWantedRef.current = false;
    stopWakeRecognition();
    void disconnectLive();
    setPhase("off");
  }, [disconnectLive, stopWakeRecognition]);

  const sendText = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    const session = sessionRef.current;
    if (!trimmed || !session) return false;
    inputTranscriptRef.current = trimmed;
    setInterim(trimmed);
    session.sendClientContent({ turns: trimmed, turnComplete: true });
    return true;
  }, []);

  useEffect(
    () => () => {
      wakeWantedRef.current = false;
      stopWakeRecognition();
      void disconnectLive();
    },
    [disconnectLive, stopWakeRecognition],
  );

  return {
    phase,
    interim,
    error,
    supported,
    wakeWordSupported,
    start,
    startNow,
    stop,
    sendText,
  };
}
