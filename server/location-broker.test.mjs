import assert from "node:assert/strict";
import { test } from "node:test";
import { LocationBroker } from "./location-broker.mjs";

test("location_error rejects a pending request immediately", async () => {
  let request;
  const broker = new LocationBroker({
    sendJson(message) {
      request = message;
    },
    timeoutMs: 10_000,
    idFactory: () => "request-1",
  });

  const pending = broker.request();
  assert.deepEqual(request, {
    type: "location_request",
    requestId: "request-1",
  });
  assert.equal(
    broker.handle({
      type: "location_error",
      requestId: "request-1",
      code: "NOT_IMPLEMENTED",
      message: "位置情報機能は準備中です",
    }),
    true,
  );
  await assert.rejects(pending, /位置情報機能は準備中です/);
});

test("location_result keeps the future GPS success path compatible", async () => {
  const broker = new LocationBroker({
    sendJson() {},
    timeoutMs: 10_000,
    idFactory: () => "request-2",
  });

  const pending = broker.request();
  broker.handle({
    type: "location_result",
    requestId: "request-2",
    lat: 35.1721,
    lng: 136.9086,
    accuracy: 12.4,
    measuredAt: "2026-09-10T03:34:56.789Z",
  });

  assert.deepEqual(await pending, {
    lat: 35.1721,
    lng: 136.9086,
    accuracy: 12.4,
    measuredAt: "2026-09-10T03:34:56.789Z",
  });
});
