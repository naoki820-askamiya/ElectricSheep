/**
 * 車載デバイス ⇄ サーバー WebSocket の型定義
 *
 * 仕様の説明は docs/websocket-protocol.md にあります。
 * Pi 側の実装は pi/passen_ws.py。3つは必ず揃えて変更してください。
 *
 * ■ 音声はここには出てきません
 * 声そのものはバイナリフレームで流れます。JSON は「これから音声が来る」
 * 「終わった」といった合図だけを運びます。
 */

import type { LatLng, SuggestedPlace } from "./api";

/** 音声の形式。ヘッダ無しの生データなので、別途こうして伝える必要がある */
export type AudioFormat = {
  /** pcm_s16le … 届いた順に再生できる（推奨） / wav … 全部揃ってから再生 */
  encoding: "pcm_s16le" | "wav";
  sampleRate: number;
  channels: number;
};

/* ------------------------------------------------------------------ */
/* 車載デバイス → サーバー                                              */
/* ------------------------------------------------------------------ */

/** 接続直後に1回だけ。これに ready が返るまで発話は送らない */
export type HelloMessage = {
  type: "hello";
  userId: string;
  device: string;
  audio: AudioFormat;
};

/** ウェイクワードを検出した。この直後からバイナリが流れ始める */
export type WakeMessage = {
  type: "wake";
  /** 検出時のスコア。閾値の調整に使うので送っている */
  score: number;
  /** ISO8601 */
  at: string;
};

/** listen を受けた後、次の発話を検出した合図。この直後から音声を送る */
export type SpeechStartMessage = { type: "speech_start" };

/** 発話が終わった。サーバーはここで溜めた音声の処理を始める */
export type EndMessage = {
  type: "end";
  /**
   * silence   … 話し終わって沈黙した（通常の終わり方）
   * no_speech … 呼びかけただけで何も話さなかった。認識もLLMも不要
   * timeout   … 話し始めてから上限に達した
   */
  reason: "silence" | "no_speech" | "timeout";
};

/**
 * location_request への応答（測位できたとき）。
 * 要求されたときだけ送る。待ち受け中に位置を送ることはない。
 */
export type LocationResultMessage = {
  type: "location_result";
  /** 要求されたものをそのまま返す。応答の取り違えを防ぐため */
  requestId: string;
  /**
   * 水平誤差の推定値（メートル）。
   * NMEA は誤差を持たないので HDOP から概算している。
   * 実測では HDOP 1.13 のとき ±12m だった。
   */
  accuracy?: number;
  /** ISO8601。GPSがこの座標を測定した時刻 */
  measuredAt?: string;
} & LatLng;

/**
 * NO_DEVICE       … GPS未接続、ポートを開けない、GPS無効で起動
 * NO_FIX          … 衛星が足りず測位できていない（屋内では普通に起きる）
 * STALE           … 測位したが古すぎる（トンネル直後など）
 * INTERNAL        … 想定外の失敗
 * NOT_IMPLEMENTED … GPS実装前の暫定コード。現在は送られない
 */
export type LocationErrorCode =
  | "NO_DEVICE"
  | "NO_FIX"
  | "STALE"
  | "INTERNAL"
  | "NOT_IMPLEMENTED";

/** location_request に対する測位失敗応答。失敗時も必ず返す */
export type LocationErrorMessage = {
  type: "location_error";
  requestId: string;
  code: LocationErrorCode;
  message: string;
};

export type PingMessage = { type: "ping" };

export type DeviceMessage =
  | HelloMessage
  | WakeMessage
  | SpeechStartMessage
  | EndMessage
  | LocationResultMessage
  | LocationErrorMessage
  | PingMessage;

/* ------------------------------------------------------------------ */
/* サーバー → 車載デバイス                                              */
/* ------------------------------------------------------------------ */

export type ReadyMessage = { type: "ready"; sessionId: string };

/** 聞き取り結果。任意だが、認識のズレを目で追えるので開発時に効く */
export type TranscriptMessage = {
  type: "transcript";
  text: string;
  /** false なら途中経過。表示を上書きしてよい */
  final: boolean;
};

/** AIの返事。api.ts の ChatResponse と同じ中身 */
export type ReplyMessage = {
  type: "reply";
  text: string;
  /** 行き先を提案したときだけ入る */
  suggestedPlace?: SuggestedPlace | null;
};

/** これから読み上げ音声を流す */
export type AudioStartMessage = { type: "audio_start" } & AudioFormat;

/** 読み上げ終わり。これが来ないと Pi は待ち受けに戻れない */
export type AudioEndMessage = { type: "audio_end" };

/** Geminiのツールが現在地を必要とした。Piは成功・失敗のどちらかを必ず返す */
export type LocationRequestMessage = {
  type: "location_request";
  requestId: string;
};

/** 返答後も同じGemini Liveセッションで次の発話を待つ */
export type ListenMessage = {
  type: "listen";
  timeoutSeconds: number;
};

export type ConversationEndedMessage = {
  type: "conversation_ended";
  reason: "user_requested" | "idle_timeout" | "no_speech" | "error";
};

export type ErrorMessage = {
  type: "error";
  code: string;
  message: string;
};

export type PongMessage = { type: "pong" };

export type ServerMessage =
  | ReadyMessage
  | TranscriptMessage
  | ReplyMessage
  | AudioStartMessage
  | AudioEndMessage
  | LocationRequestMessage
  | ListenMessage
  | ConversationEndedMessage
  | ErrorMessage
  | PongMessage;

/* ------------------------------------------------------------------ */
/* 取り決めの値                                                         */
/* ------------------------------------------------------------------ */

/** Pi が送ってくる音声の形式。サーバーはこれを前提にしてよい */
export const DEVICE_AUDIO: AudioFormat = {
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
};

/** バイナリ1フレームぶんのサンプル数（80ms）。openWakeWord の想定に合わせてある */
export const FRAME_SAMPLES = 1280;

/** 受け取ったメッセージが期待した型か確かめる。壊れた JSON で落ちないように */
export function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
