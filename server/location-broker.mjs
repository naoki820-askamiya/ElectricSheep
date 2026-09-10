import { randomUUID } from "node:crypto";
import { validateCoordinates } from "./visit-drafts.mjs";

export class LocationBroker {
  constructor({ sendJson, timeoutMs, idFactory = randomUUID }) {
    this.sendJson = sendJson;
    this.timeoutMs = timeoutMs;
    this.idFactory = idFactory;
    this.pending = new Map();
  }

  request() {
    const requestId = this.idFactory();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Raspberry Piから位置情報が返りませんでした"));
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      this.sendJson({ type: "location_request", requestId });
    });
  }

  handle(message) {
    if (
      message?.type !== "location_result" &&
      message?.type !== "location_error"
    ) {
      return false;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);

    if (message.type === "location_error") {
      pending.reject(
        new Error(message.message || "Raspberry Piで位置情報を取得できませんでした"),
      );
      return true;
    }

    try {
      pending.resolve({
        ...validateCoordinates(message.lat, message.lng),
        accuracy: message.accuracy,
        measuredAt: message.measuredAt,
      });
    } catch (error) {
      pending.reject(error);
    }
    return true;
  }

  close(reason = "端末との接続が切れました") {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
