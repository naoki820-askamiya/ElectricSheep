import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
} from "@google/genai";
import { LIVE_TOOL_DECLARATIONS } from "./live-tools.mjs";
import { PASSEN_SYSTEM_PROMPT } from "./system-prompt.mjs";

function mergeTranscript(current, next) {
  if (!next) return current;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return current + next;
}

export class GeminiLiveConversation {
  constructor({
    apiKey,
    model,
    voice,
    toolController,
    sendJson,
    sendBinary,
    onTurnComplete,
    onToolActivity,
    onFatalError,
    ai,
  }) {
    this.ai = ai ?? new GoogleGenAI({ apiKey });
    this.model = model;
    this.voice = voice;
    this.toolController = toolController;
    this.sendJson = sendJson;
    this.sendBinary = sendBinary;
    this.onTurnComplete = onTurnComplete;
    this.onToolActivity = onToolActivity;
    this.onFatalError = onFatalError;
    this.session = null;
    this.userTurnActive = false;
    this.audioStarted = false;
    this.outputTranscript = "";
    this.closeAfterTurn = false;
    this.intentionalClose = false;
    this.messageQueue = Promise.resolve();
    this.toolResults = new Map();
  }

  async connect() {
    if (this.session) return;
    this.session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: PASSEN_SYSTEM_PROMPT,
        tools: [{ functionDeclarations: LIVE_TOOL_DECLARATIONS }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
        },
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
        },
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        temperature: 0.5,
        maxOutputTokens: 1024,
      },
      callbacks: {
        onmessage: (message) => {
          this.messageQueue = this.messageQueue
            .then(() => this.handleMessage(message))
            .catch((error) => this.fail(error));
        },
        onerror: (event) => {
          this.fail(event?.error ?? new Error(event?.message || "Gemini Liveエラー"));
        },
        onclose: (event) => {
          this.session = null;
          if (!this.intentionalClose) {
            this.fail(
              new Error(event?.reason || "Gemini Liveとの接続が切れました"),
            );
          }
        },
      },
    });
  }

  startUserTurn() {
    if (!this.session) throw new Error("Gemini Liveへ接続していません");
    if (this.userTurnActive) return;
    this.resetModelTurn();
    this.session.sendRealtimeInput({ activityStart: {} });
    this.userTurnActive = true;
  }

  sendAudio(bytes) {
    if (!this.session) throw new Error("Gemini Liveへ接続していません");
    if (!this.userTurnActive) this.startUserTurn();
    this.session.sendRealtimeInput({
      audio: {
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  endUserTurn() {
    if (!this.session || !this.userTurnActive) return;
    this.session.sendRealtimeInput({ activityEnd: {} });
    this.userTurnActive = false;
  }

  async handleMessage(message) {
    const serverContent = message.serverContent;
    if (serverContent?.interimInputTranscription?.text) {
      this.sendJson({
        type: "transcript",
        text: serverContent.interimInputTranscription.text,
        final: false,
      });
    }
    if (serverContent?.inputTranscription?.text) {
      this.sendJson({
        type: "transcript",
        text: serverContent.inputTranscription.text,
        final: serverContent.inputTranscription.finished !== false,
      });
    }
    if (serverContent?.outputTranscription?.text) {
      this.outputTranscript = mergeTranscript(
        this.outputTranscript,
        serverContent.outputTranscription.text,
      );
    }

    for (const part of serverContent?.modelTurn?.parts ?? []) {
      if (part.text) {
        this.outputTranscript = mergeTranscript(this.outputTranscript, part.text);
      }
      if (part.inlineData?.data) {
        if (!this.audioStarted) {
          this.audioStarted = true;
          this.sendJson({
            type: "audio_start",
            encoding: "pcm_s16le",
            sampleRate: 24000,
            channels: 1,
          });
        }
        this.sendBinary(Buffer.from(part.inlineData.data, "base64"));
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      await this.handleToolCalls(message.toolCall.functionCalls);
    }

    if (serverContent?.turnComplete) {
      const reply = this.outputTranscript.trim();
      if (reply) this.sendJson({ type: "reply", text: reply });
      if (this.audioStarted) this.sendJson({ type: "audio_end" });
      const closeAfterTurn = this.closeAfterTurn;
      this.resetModelTurn();
      await this.onTurnComplete({ closeAfterTurn });
    }
  }

  async handleToolCalls(functionCalls) {
    this.onToolActivity();
    const functionResponses = [];

    for (const call of functionCalls) {
      const callId = call.id || `${call.name}-${this.toolResults.size}`;
      let response = this.toolResults.get(callId);
      if (!response) {
        try {
          const result = await this.toolController.execute(call.name, call.args ?? {});
          if (result.closeConversation) this.closeAfterTurn = true;+          response = { output: result };
        } catch (error) {
          response = {
            error: {
              message:
                error instanceof Error ? error.message : "ツールの実行に失敗しました",
            },
          };
        }
        this.toolResults.set(callId, response);
      }
      functionResponses.push({
        id: call.id,
        name: call.name,
        response,
      });
    }

    this.session?.sendToolResponse({ functionResponses });
  }

  resetModelTurn() {
    this.audioStarted = false;
    this.outputTranscript = "";
  }

  close() {
    this.intentionalClose = true;
    this.userTurnActive = false;
    this.session?.close();
    this.session = null;
  }

  fail(error) {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    this.session?.close();
    this.session = null;
    this.onFatalError(
      error instanceof Error ? error : new Error("Gemini Liveエラー"),
    );
  }
}
