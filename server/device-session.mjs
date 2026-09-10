import { randomUUID } from "node:crypto";
import { GeminiLiveConversation } from "./gemini-live.mjs";
import { LiveToolController } from "./live-tools.mjs";
import { LocationBroker } from "./location-broker.mjs";

function safeJsonParse(data) {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function validUserId(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !value.includes("/")
  );
}

export class DeviceSession {
  constructor({ socket, requestUserId, config, drafts, placeRepository }) {
    this.socket = socket;
    this.config = config;
    this.drafts = drafts;
    this.placeRepository = placeRepository;
    this.deviceSessionId = randomUUID();
    this.requestUserId = requestUserId;
    this.userId = null;
    this.helloReceived = false;
    this.conversation = null;
    this.conversationId = null;
    this.state = "waiting_for_wake";
    this.idleTimer = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.locationBroker = new LocationBroker({
      sendJson: (message) => this.sendJson(message),
      timeoutMs: config.locationTimeoutMs,
    });

    socket.on("message", (data, isBinary) => {
      this.queue = this.queue
        .then(() => this.handleFrame(data, isBinary))
        .catch((error) => this.reportError("BAD_MESSAGE", error));
    });
    socket.on("close", () => this.close());
    socket.on("error", (error) => {
      console.error(`[Pi ${this.deviceSessionId}] WebSocket error:`, error.message);
      this.close();
    });
  }

  async handleFrame(data, isBinary) {
    if (isBinary) {
      if (!this.conversation) {
        throw new Error("会話開始前に音声が届きました");
      }
      this.pauseIdleTimer();
      this.state = "listening";
      this.conversation.sendAudio(data);
      return;
    }

    const message = safeJsonParse(data);
    if (!message?.type) throw new Error("typeを持つJSONが必要です");
    if (this.locationBroker.handle(message)) return;

    switch (message.type) {
      case "hello":
        this.handleHello(message);
        break;
      case "ping":
        this.sendJson({ type: "pong" });
        break;
      case "wake":
        await this.startUserTurn(true);
        break;
      case "speech_start":
        await this.startUserTurn(false);
        break;
      case "end":
        this.endUserTurn();
        break;
      default:
        throw new Error(`未対応のメッセージです: ${message.type}`);
    }
  }

  handleHello(message) {
    if (this.helloReceived) throw new Error("helloは接続直後の1回だけ送れます");
    const requestedUserId = message.userId || this.requestUserId;
    if (!validUserId(requestedUserId)) throw new Error("userIdが不正です");
    if (
      message.audio?.encoding !== "pcm_s16le" ||
      message.audio?.sampleRate !== 16000 ||
      message.audio?.channels !== 1
    ) {
      throw new Error("音声はpcm_s16le / 16000Hz / monoで送ってください");
    }

    this.userId = this.config.firestoreUserIdOverride || requestedUserId;
    this.helloReceived = true;
    this.sendJson({ type: "ready", sessionId: this.deviceSessionId });
  }

  async startUserTurn(fromWake) {
    if (!this.helloReceived) throw new Error("先にhelloを送ってください");
    if (!this.conversation) {
      if (!fromWake) throw new Error("最初の発話にはwakeが必要です");
      await this.openConversation();
    }
    this.pauseIdleTimer();
    this.state = "listening";
    this.conversation.startUserTurn();
  }

  endUserTurn() {
    if (!this.conversation) throw new Error("会話が開始されていません");
    this.pauseIdleTimer();
    this.state = "model_responding";
    this.conversation.endUserTurn();
  }

  async openConversation() {
    this.conversationId = randomUUID();
    const toolController = new LiveToolController({
      sessionId: this.conversationId,
      userId: this.userId,
      drafts: this.drafts,
      locationBroker: this.locationBroker,
      placeRepository: this.placeRepository,
      nearbyRadiusMeters: this.config.nearbyRadiusMeters,
    });
    const conversation = new GeminiLiveConversation({
      apiKey: this.config.geminiApiKey,
      model: this.config.geminiModel,
      voice: this.config.geminiVoice,
      toolController,
      sendJson: (message) => this.sendJson(message),
      sendBinary: (bytes) => this.sendBinary(bytes),
      onToolActivity: () => {
        this.pauseIdleTimer();
        this.state = "tool_processing";
      },
      onTurnComplete: ({ closeAfterTurn }) =>
        this.handleModelTurnComplete(closeAfterTurn),
      onFatalError: (error) => this.handleGeminiError(error),
    });

    await conversation.connect();
    this.conversation = conversation;
    this.startIdleTimer();
  }

  async handleModelTurnComplete(closeAfterTurn) {
    if (closeAfterTurn) {
      this.endConversation("user_requested");
      return;
    }
    this.state = "awaiting_user";
    this.sendJson({
      type: "listen",
      timeoutSeconds: Math.floor(this.config.conversationIdleMs / 1000),
    });
    this.startIdleTimer();
  }

  startIdleTimer() {
    this.pauseIdleTimer();
    this.idleTimer = setTimeout(
      () => this.endConversation("idle_timeout"),
      this.config.conversationIdleMs,
    );
  }

  pauseIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  endConversation(reason) {
    this.pauseIdleTimer();
    if (this.conversationId) this.drafts.delete(this.conversationId);
    this.conversation?.close();
    this.conversation = null;
    this.conversationId = null;
    this.state = "waiting_for_wake";
    this.sendJson({ type: "conversation_ended", reason });
  }

  handleGeminiError(error) {
    this.reportError("GEMINI_LIVE_FAILED", error);
    this.endConversation("error");
  }

  reportError(code, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Pi ${this.deviceSessionId}] ${code}: ${message}`);
    this.sendJson({ type: "error", code, message });
  }

  sendJson(message) {
    if (!this.closed && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(message));
    }
  }

  sendBinary(bytes) {
    if (!this.closed && this.socket.readyState === 1) {
      this.socket.send(bytes, { binary: true });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.locationBroker.close("Piとの接続が切れました");
    this.pauseIdleTimer();
    if (this.conversationId) this.drafts.delete(this.conversationId);
    this.conversation?.close();
    this.conversation = null;
  }
}
