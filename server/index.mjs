import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";
import { DeviceSession } from "./device-session.mjs";
import { createPlaceRepository } from "./place-repository.mjs";
import { VisitDraftStore } from "./visit-drafts.mjs";

function rejectUpgrade(socket, statusCode, message) {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
}

export function createBackend({
  config = loadConfig(),
  drafts = new VisitDraftStore(),
  placeRepository = createPlaceRepository(config),
  sessionFactory = (options) => new DeviceSession(options),
} = {}) {
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found\n");
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (
      config.deviceToken &&
      url.searchParams.get("token") !== config.deviceToken
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, url);
    });
  });

  webSocketServer.on("connection", (socket, _request, url) => {
    sessionFactory({
      socket,
      requestUserId: url.searchParams.get("userId"),
      config,
      drafts,
      placeRepository,
    });
  });

  return {
    httpServer,
    webSocketServer,
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(config.port, config.host);
      });
      return httpServer.address();
    },
    async close() {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve, reject) => {
        webSocketServer.close(() => {
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const config = loadConfig();
    const backend = createBackend({ config });
    await backend.listen();
    console.log(
      `パッセンバックエンド起動: ws://${config.host}:${config.port}/ws`,
    );
    console.log(
      `DB: ${config.dbMode} / Gemini Live: ${config.geminiModel} / voice: ${config.geminiVoice}`,
    );

    const shutdown = async () => {
      await backend.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "バックエンドを起動できませんでした",
    );
    process.exitCode = 1;
  }
}
