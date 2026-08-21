/**
 * パッセン API 契約（フロント・バックエンド共通の取り決め）
 *
 * このファイルがチームの「つなぎ目の仕様書」です。
 * ここを変更するときは必ずバックエンド（よしたか）・DB（ゆづき）・LLM（なおき）に共有すること。
 */

/** 緯度経度 */
export type LatLng = {
  lat: number;
  lng: number;
};

/** 訪れた場所 / これから訪れる場所 */
export type Place = {
  id: string;
  name: string;
  /** 住所や地名の表示用テキスト */
  address?: string;
  location: LatLng;
  /** 訪問済みなら ISO8601 の日時。未訪問なら undefined */
  visitedAt?: string;
  /** その場所にまつわる思い出（ユーザーが語った内容をLLMが要約したもの） */
  memory?: string;
  /** 写真URL（Want機能。無ければ undefined） */
  photoUrl?: string;
};

/** 対話の1発言 */
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO8601 */
  createdAt: string;
};

/* ------------------------------------------------------------------ */
/* POST /api/chat  — 対話機能（コア機能）                              */
/* ------------------------------------------------------------------ */

export type ChatRequest = {
  userId: string;
  message: string;
  /** 車載なので現在地を毎回送る。LLMが「この近くに〇〇がありますね」と言えるようにするため */
  currentLocation?: LatLng;
  /**
   * これまでの会話。新しいものが後ろ。
   * これを送らないとAIが毎回会話の流れを忘れるため、対話の質に直結する。
   * 長くなりすぎないよう、送る側で直近の数往復に絞ること。
   */
  history?: Message[];
};

export type ChatResponse = {
  /** AIの返答テキスト */
  reply: string;
  /**
   * AIが「行き先」を提案したときだけ入る。
   * これが入っていたらフロントは地図にピンを立てて「ここへ向かいますか？」を出す。
   */
  suggestedPlace?: Place;
};

/* ------------------------------------------------------------------ */
/* GET /api/places  — 訪れた場所の保存・取得                            */
/* ------------------------------------------------------------------ */

export type GetPlacesResponse = {
  places: Place[];
};

/** POST /api/places — 場所を「訪れた」として記録する */
export type CreatePlaceRequest = {
  userId: string;
  name: string;
  location: LatLng;
  memory?: string;
};

export type CreatePlaceResponse = {
  place: Place;
};

/* ------------------------------------------------------------------ */
/* エラー                                                              */
/* ------------------------------------------------------------------ */

/** APIがエラーを返すときの共通形式 */
export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
