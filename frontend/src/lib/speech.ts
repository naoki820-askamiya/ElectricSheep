/**
 * 音声の入出力をブラウザ標準機能で行う実装。
 *
 * ここはあとで差し替える前提の層。
 *   音声認識  … いずれ Vosk（オフライン）やサーバー側 STT へ
 *   音声合成  … いずれ VOICEVOX へ
 * 呼び出し側（useVoiceAgent）はこのファイルの関数だけを見ているので、
 * 中身を入れ替えても画面のコードは変わらない。
 */

/** 音声認識が使えるか（Chrome / Edge 系のみ。Firefox は未対応） */
export function isRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

/** 音声合成が使えるか */
export function isSynthesisSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "speechSynthesis" in window;
}

export function createRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = "ja-JP";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  return recognition;
}

/* ------------------------------------------------------------------ */
/* ウェイクワード判定                                                  */
/* ------------------------------------------------------------------ */

/**
 * 音声認識は「パッセン」を毎回そのまま返してくれるとは限らない。
 * ひらがな・カタカナの揺れに加えて、「8000（はっせん）」のように
 * 全く違う文字列で返ってくることが実際にある。
 * 実機で試して増やしていく前提のリスト。
 */
const WAKE_WORD_VARIANTS = [
  "ぱっせん",
  "ぱっせんさん",
  "ぱつせん",
  "はっせん",
  "8000",
  "パッセン",
];

/** カタカナをひらがなに寄せる。文字位置は変えない。 */
function foldKana(text: string): string {
  return text
    .replace(/[ァ-ヶ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0x60),
    )
    .toLowerCase();
}

/** 空白と句読点も落として比較しやすくする */
function normalize(text: string): string {
  return foldKana(text).replace(/[\s、。,.！!？?]/g, "");
}

/** 聞き取った文にウェイクワードが含まれるか */
export function containsWakeWord(text: string): boolean {
  const normalized = normalize(text);
  return WAKE_WORD_VARIANTS.some((w) => normalized.includes(normalize(w)));
}

/**
 * ウェイクワードより後ろの部分を取り出す。
 * 「パッセン、海に行きたい」のように続けて喋られた場合に、
 * 「海に行きたい」だけを本文として扱うため。
 */
export function stripWakeWord(text: string): string {
  const folded = foldKana(text);
  let cut = -1;

  for (const word of WAKE_WORD_VARIANTS) {
    const foldedWord = foldKana(word);
    const index = folded.indexOf(foldedWord);
    if (index >= 0) cut = Math.max(cut, index + foldedWord.length);
  }
  if (cut < 0) return text.trim();

  return text.slice(cut).replace(/^[\s、。,.]+/, "").trim();
}

/* ------------------------------------------------------------------ */
/* 読み上げ                                                            */
/* ------------------------------------------------------------------ */

let cachedVoice: SpeechSynthesisVoice | null = null;

/** 日本語の声を選ぶ。声の一覧は非同期で読み込まれるので都度探す */
function pickJapaneseVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  const japanese = voices.find((v) => v.lang === "ja-JP" || v.lang === "ja_JP");
  if (japanese) cachedVoice = japanese;
  return japanese ?? null;
}

/**
 * テキストを読み上げる。読み終わったら解決する Promise を返す。
 * 読み上げ中はマイクを止める必要があるので、終了を待てることが重要。
 */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!isSynthesisSupported() || !text.trim()) {
      resolve();
      return;
    }

    // 前の読み上げが残っていると重なるので必ず消す
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.95; // 少しゆっくり喋らせる
    utterance.pitch = 1;

    const voice = pickJapaneseVoice();
    if (voice) utterance.voice = voice;

    // onend が呼ばれないブラウザがあるため、保険のタイマーを併用する
    const fallback = window.setTimeout(
      () => resolve(),
      3000 + text.length * 120,
    );
    const finish = () => {
      window.clearTimeout(fallback);
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
  });
}

/** 読み上げを中断する */
export function stopSpeaking(): void {
  if (isSynthesisSupported()) window.speechSynthesis.cancel();
}
