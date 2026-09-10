import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { createBackend } from "./index.mjs";

function testConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    geminiApiKey: "test-key",
    geminiModel: "test-model",
    geminiVoice: "Kore",
    conversationIdleMs: 1_000,
    locationTimeoutMs: 100,
    nearbyRadiusMeters: 100,
    firebaseProjectId: "test-project",
    firestoreUserIdOverride: null,
    dbMode: "memory",
    deviceToken: null,
    ...overrides,
  };
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => {
      try {
        assert.equal(isBinary, false);
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("health check and Pi hello work on the standalone backend", async () => {
  const backend = createBackend({ config: testConfig() });
  try {
    const address = await backend.listen();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const socket = await openWebSocket(
      `ws://127.0.0.1:${address.port}/ws?userId=pi-demo`,
    );
    socket.send(
      JSON.stringify({
        type: "hello",
        userId: "pi-demo",
        device: "test-pi",
        audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
      }),
    );
    const ready = await nextJson(socket);
    assert.equal(ready.type, "ready");
    assert.equal(typeof ready.sessionId, "string");
    socket.close();
  } finally {
    await backend.close();
  }
});

test("device token rejects unauthenticated WebSocket upgrades", async () => {
  const backend = createBackend({
    config: testConfig({ deviceToken: "secret" }),
  });
  try {
    const address = await backend.listen();
    await assert.rejects(
      openWebSocket(`ws://127.0.0.1:${address.port}/ws`),
      /Unexpected server response: 401/,
    );
  } finally {
    await backend.close();
  }
});
