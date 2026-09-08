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

import type { LatLng, Place } from "./api";

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

/** 発話が終わった。サーバーはここで溜めた音声の処理を始める */
export type EndMessage = {
  type: "end";
  /** silence … 無音を検出 / timeout … 上限に達した */
  reason: "silence" | "timeout";
};

/** スマートフォンから位置が取れているときだけ。任意 */
export type LocationMessage = { type: "location" } & LatLng;

export type PingMessage = { type: "ping" };

export type DeviceMessage =
  | HelloMessage
  | WakeMessage
  | EndMessage
  | LocationMessage
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
  suggestedPlace?: Place | null;
};

/** これから読み上げ音声を流す */
export type AudioStartMessage = { type: "audio_start" } & AudioFormat;

/** 読み上げ終わり。これが来ないと Pi は待ち受けに戻れない */
export type AudioEndMessage = { type: "audio_end" };

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
