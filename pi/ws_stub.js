/**
 * 検証用の WebSocket スタブサーバー。
 *
 * よしたかの本実装ができるまで、Pi 側の動作を確かめるためだけのもの。
 * 音声認識も LLM も入っていない。受け取った音声を WAV に保存し、
 * 固定の返事とビープ音を返すだけ。
 *
 *   node ws_stub.js
 *
 * 確かめられること:
 *   - Pi が正しく繋がり hello を送るか
 *   - 発話の切れ目（無音1.2秒）で end が飛ぶか
 *   - 送られた音声がちゃんと声として録れているか（recv_*.wav を再生して確認）
 *   - 返事の音声が Pi のスピーカーから鳴るか
 */
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const OUT_DIR = path.join(__dirname, "recv");

const REPLIES = [
  "海ですか。いいですね。どちらの海でしょう。",
  "そのお話、もう少し聞かせてください。",
  "懐かしい場所ですね。いつ頃のことですか。",
];
let replyIndex = 0;

fs.mkdirSync(OUT_DIR, { recursive: true });

/** ヘッダの無い PCM に WAV のヘッダを被せる。再生して中身を耳で確かめるため */
function toWav(pcm, rate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 返事の代わりに鳴らす音。合成が無いので上がる音階で代用する */
function makeTone(rate = 24000, seconds = 0.9) {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const freq = 440 + (220 * i) / n;
    const fade = Math.min(1, (n - i) / (rate * 0.15));
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * fade;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

const TONE = makeTone();

const wss = new WebSocketServer({ port: PORT });
console.log(`WS スタブ起動: ws://0.0.0.0:${PORT}/ws`);
console.log(`受け取った音声の保存先: ${OUT_DIR}\n`);

wss.on("connection", (ws, req) => {
  const sessionId = Math.random().toString(36).slice(2, 8);
  let chunks = [];
  let capturing = false;

  console.log(`[${sessionId}] 接続 ${req.url}`);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (capturing) chunks.push(Buffer.from(data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`[${sessionId}] JSON として読めません`);
      return;
    }

    if (msg.type === "hello") {
      console.log(`[${sessionId}] hello user=${msg.userId} device=${msg.device}`);
      ws.send(JSON.stringify({ type: "ready", sessionId }));
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "wake") {
      console.log(`[${sessionId}] wake score=${msg.score}`);
      chunks = [];
      capturing = true;
      return;
    }

    if (msg.type === "end") {
      capturing = false;
      const pcm = Buffer.concat(chunks);
      const seconds = (pcm.length / 2 / 16000).toFixed(1);
      const file = path.join(OUT_DIR, `recv_${sessionId}_${Date.now()}.wav`);
      fs.writeFileSync(file, toWav(pcm));
      console.log(`[${sessionId}] end(${msg.reason}) ${seconds}秒 → ${path.basename(file)}`);

      const text = REPLIES[replyIndex % REPLIES.length];
      replyIndex += 1;

      // 本来はここで音声認識と LLM が入る。スタブなので固定文を返す
      ws.send(JSON.stringify({ type: "transcript", text: "（スタブなので認識していません）", final: true }));
      ws.send(JSON.stringify({ type: "reply", text }));
      ws.send(JSON.stringify({ type: "audio_start", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 }));

      // 実際の合成音声のように、少しずつ流れてくる状況を再現する
      const STEP = 4800; // 0.2秒ぶん
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= TONE.length) {
          clearInterval(timer);
          ws.send(JSON.stringify({ type: "audio_end" }));
          console.log(`[${sessionId}] 返事を送りました: ${text}`);
          return;
        }
        ws.send(TONE.subarray(offset, offset + STEP));
        offset += STEP;
      }, 100);
      return;
    }

    if (msg.type === "location") {
      console.log(`[${sessionId}] location ${msg.lat}, ${msg.lng}`);
      return;
    }

    console.log(`[${sessionId}] 未知のメッセージ: ${msg.type}`);
  });

  ws.on("close", () => console.log(`[${sessionId}] 切断`));
  ws.on("error", (e) => console.log(`[${sessionId}] エラー: ${e.message}`));
});
