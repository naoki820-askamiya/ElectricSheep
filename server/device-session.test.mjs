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
