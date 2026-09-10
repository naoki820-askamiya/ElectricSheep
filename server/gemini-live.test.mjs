import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiLiveConversation } from "./gemini-live.mjs";

test("tool results are returned to Gemini and can request conversation close", async () => {
  let sent;
  const result = { ok: true, closeConversation: true };
  const conversation = new GeminiLiveConversation({
    apiKey: "test-key",
    model: "test-model",
    voice: "Kore",
    ai: {},
    toolController: { execute: async () => result },
    sendJson() {},
    sendBinary() {},
    onTurnComplete() {},
    onToolActivity() {},
    onFatalError() {},
  });
  conversation.session = {
    sendToolResponse(value) {
      sent = value;
    },
  };

  await conversation.handleToolCalls([
    { id: "call-1", name: "end_conversation", args: {} },
  ]);

  assert.equal(conversation.closeAfterTurn, true);
  assert.deepEqual(sent, {
    functionResponses: [
      {
        id: "call-1",
        name: "end_conversation",
        response: { output: result },
      },
    ],
  });
});
