const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function downsample(
  input: Float32Array,
  inputSampleRate: number,
): Float32Array {
  if (inputSampleRate === INPUT_SAMPLE_RATE) return input;

  const ratio = inputSampleRate / INPUT_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
    }
    output[outputIndex] = sum / Math.max(1, end - start);
  }

  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function base64ToPcm16(base64: string): Int16Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // PCM16 は little-endian。DataView を使い、実行環境のendianに依存しないようにする。
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

/** マイク音声をLive APIが要求する16kHz PCM16へ変換する。 */
export class LiveMicrophone {
  private startAttempt = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  async start(onChunk: (base64Pcm: string) => void): Promise<void> {
    if (this.stream) return;

    const attempt = this.startAttempt + 1;
    this.startAttempt = attempt;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // 権限ダイアログの表示中に停止された場合、取得直後に必ず破棄する。
    if (attempt !== this.startAttempt) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;

    const context = new AudioContext();
    await context.resume();
    if (attempt !== this.startAttempt) {
      stream.getTracks().forEach((track) => track.stop());
      if (context.state !== "closed") await context.close();
      return;
    }
    const source = context.createMediaStreamSource(stream);

    // 48kHz環境なら約43msずつ送る。Live API推奨の20〜40msに近い単位。
    const processor = context.createScriptProcessor(2048, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const mono = event.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16(downsample(mono, context.sampleRate));
      onChunk(bytesToBase64(new Uint8Array(pcm.buffer)));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);

    this.context = context;
    this.source = source;
    this.processor = processor;
    this.silentGain = silentGain;
  }

  async stop(): Promise<void> {
    this.startAttempt += 1;
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    const context = this.context;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;

    if (context && context.state !== "closed") await context.close();
  }
}

/** Geminiが返す24kHz PCM16を途切れないよう順番に再生する。 */
export class LivePcmPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  async prepare(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
    }
    await this.context.resume();
    this.nextStartTime = Math.max(this.nextStartTime, this.context.currentTime);
  }

  async enqueue(base64Pcm: string): Promise<void> {
    await this.prepare();
    const context = this.context;
    if (!context) return;

    const pcm = base64ToPcm16(base64Pcm);
    const audioBuffer = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = pcm[index] / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };

    const startAt = Math.max(context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;
    this.sources.add(source);
  }

  stopQueuedAudio(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // すでに再生終了している場合は何もしない。
      }
    }
    this.sources.clear();
    if (this.context) this.nextStartTime = this.context.currentTime;
  }

  async close(): Promise<void> {
    this.stopQueuedAudio();
    const context = this.context;
    this.context = null;
    this.nextStartTime = 0;
    if (context && context.state !== "closed") await context.close();
  }
}
