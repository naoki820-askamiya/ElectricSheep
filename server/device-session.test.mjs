import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DeviceSession } from "./device-session.mjs";
import { MemoryPlaceRepository } from "./place-repository.mjs";
import { VisitDraftStore } from "./visit-drafts.mjs";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];

  send(data, options) {
    this.sent.push({ data, options });
  }
}

function config() {
  return {
    geminiApiKey: "test-key",
    geminiModel: "test-model",
    geminiVoice: "Kore",
    conversationIdleMs: 60_000,
    locationTimeoutMs: 100,
    nearbyRadiusMeters: 100,
    firestoreUserIdOverride: null,
  };
}

function emitJson(socket, message) {
  socket.emit("message", Buffer.from(JSON.stringify(message)), false);
}

function sentJson(socket) {
  return socket.sent
    .filter(({ options }) => !options?.binary)
    .map(({ data }) => JSON.parse(data));
}

test("no_speech closes the Live session without ending a Gemini user turn", async () => {
  const socket = new FakeSocket();
  const calls = [];
  const conversation = {
    async connect() {
      calls.push("connect");
    },
    startUserTurn() {
      calls.push("startUserTurn");
    },
    sendAudio() {
      calls.push("sendAudio");
    },
    endUserTurn() {
      calls.push("endUserTurn");
    },
    close() {
      calls.push("close");
    },
  };
  const session = new DeviceSession({
    socket,
    requestUserId: "pi-demo",
    config: config(),
    drafts: new VisitDraftStore(),
    placeRepository: new MemoryPlaceRepository(),
    conversationFactory: () => conversation,
  });

  emitJson(socket, {
    type: "hello",
    userId: "pi-demo",
    audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  });
  emitJson(socket, { type: "wake", score: 0.9, at: new Date().toISOString() });
  socket.emit("message", Buffer.alloc(2560), true);
  emitJson(socket, { type: "end", reason: "no_speech" });
  await session.queue;

  assert.deepEqual(calls, ["connect", "startUserTurn", "sendAudio", "close"]);
  assert.equal(session.conversation, null);
  assert.equal(session.state, "waiting_for_wake");
  assert.ok(
    sentJson(socket).some(
      (message) =>
        message.type === "conversation_ended" && message.reason === "no_speech",
    ),
  );
  session.close();
});

test("normal speech end is forwarded to Gemini", async () => {
  const socket = new FakeSocket();
  let ended = 0;
  const conversation = {
    async connect() {},
    startUserTurn() {},
    sendAudio() {},
    endUserTurn() {
      ended += 1;
    },
    close() {},
  };
  const session = new DeviceSession({
    socket,
    requestUserId: "pi-demo",
    config: config(),
    drafts: new VisitDraftStore(),
    placeRepository: new MemoryPlaceRepository(),
    conversationFactory: () => conversation,
  });

  emitJson(socket, {
    type: "hello",
    userId: "pi-demo",
    audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  });
  emitJson(socket, { type: "wake", score: 0.9, at: new Date().toISOString() });
  emitJson(socket, { type: "end", reason: "silence" });
  await session.queue;

  assert.equal(ended, 1);
  assert.equal(session.state, "model_responding");
  session.close();
});

test("静かなときの合図で、こちらから話し始める", async () => {
  const socket = new FakeSocket();
  const calls = [];
  const cues = [];
  const conversation = {
    async connect() {
      calls.push("connect");
    },
    startUserTurn() {
      calls.push("startUserTurn");
    },
    sendCue(text) {
      calls.push("sendCue");
      cues.push(text);
    },
    sendAudio() {
      calls.push("sendAudio");
    },
    endUserTurn() {
      calls.push("endUserTurn");
    },
    close() {
      calls.push("close");
    },
  };
  const session = new DeviceSession({
    socket,
    requestUserId: "pi-demo",
    config: config(),
    drafts: new VisitDraftStore(),
    placeRepository: new MemoryPlaceRepository(),
    conversationFactory: () => conversation,
  });

  emitJson(socket, {
    type: "hello",
    userId: "pi-demo",
    audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  });
  emitJson(socket, { type: "nudge" });
  await session.queue;

  // ユーザーの発話は無いので、声のターンは始めない
  assert.deepEqual(calls, ["connect", "sendCue"]);
  assert.match(cues[0], /【合図】/);
  assert.match(cues[0], /recall_places/);
  assert.equal(session.state, "model_responding");

  // 合図のあとは、普通の会話と同じように声を送れる
  emitJson(socket, { type: "speech_start" });
  socket.emit("message", Buffer.alloc(2560), true);
  emitJson(socket, { type: "end", reason: "silence" });
  await session.queue;
  assert.deepEqual(calls, [
    "connect",
    "sendCue",
    "startUserTurn",
    "sendAudio",
    "endUserTurn",
  ]);

  session.close?.();
});

test("会話中の合図は割り込まずに無視する", async () => {
  const socket = new FakeSocket();
  const calls = [];
  const conversation = {
    async connect() {
      calls.push("connect");
    },
    startUserTurn() {
      calls.push("startUserTurn");
    },
    sendCue() {
      calls.push("sendCue");
    },
    sendAudio() {},
    endUserTurn() {},
    close() {
      calls.push("close");
    },
  };
  const session = new DeviceSession({
    socket,
    requestUserId: "pi-demo",
    config: config(),
    drafts: new VisitDraftStore(),
    placeRepository: new MemoryPlaceRepository(),
    conversationFactory: () => conversation,
  });

  emitJson(socket, {
    type: "hello",
    userId: "pi-demo",
    audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  });
  emitJson(socket, { type: "wake", score: 0.9, at: new Date().toISOString() });
  emitJson(socket, { type: "nudge" });
  await session.queue;

  assert.deepEqual(calls, ["connect", "startUserTurn"]);
  assert.equal(sentJson(socket).some((m) => m.type === "error"), false);
});

test("helloの前の合図は断る", async () => {
  const socket = new FakeSocket();
  const session = new DeviceSession({
    socket,
    requestUserId: "pi-demo",
    config: config(),
    drafts: new VisitDraftStore(),
    placeRepository: new MemoryPlaceRepository(),
    conversationFactory: () => ({ async connect() {}, close() {} }),
  });

  emitJson(socket, { type: "nudge" });
  await session.queue;

  assert.equal(sentJson(socket).some((m) => m.type === "error"), true);
  assert.equal(session.conversation, null);
});
