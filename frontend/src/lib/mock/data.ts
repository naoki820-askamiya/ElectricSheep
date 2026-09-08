import { Place } from '@/types/database';

/** デモ用の固定ユーザーID。認証を作るまではこれを使う */
export const MOCK_USER_ID = "demo-user";

/** 名古屋近辺を想定したデモ用の場所データ */
export const MOCK_PLACES: Place[] = [
  {
    id: "place-1",
    name: "名古屋テレビ塔",
    address: "愛知県名古屋市中区錦3-6-15",
    location: { lat: 35.1721, lng: 136.9086 },
    visitedAt: "1965-04-10T10:00:00+09:00",
    memory: "初めてのデートで登った。展望台から見た夕日が忘れられない。",
  },
  {
    id: "place-2",
    name: "熱田神宮",
    address: "愛知県名古屋市熱田区神宮1-1-1",
    location: { lat: 35.1275, lng: 136.9086 },
    visitedAt: "1972-01-01T08:30:00+09:00",
    memory: "毎年家族で初詣に来ていた場所。",
  },
  {
    id: "place-3",
    name: "常滑焼の窯元",
    address: "愛知県常滑市栄町",
    location: { lat: 34.8869, lng: 136.8577 },
    visitedAt: "1988-09-23T14:00:00+09:00",
    memory: "父と一緒に湯呑みを焼いた。今も棚に置いてある。",
  },
];

/**
 * モックの対話応答。
 * なおきのLLMが繋がるまで、この関数でそれっぽい返答を返す。
 */
export function mockReply(userMessage: string): {
  reply: string;
  suggestedPlace?: Place;
} {
  const text = userMessage.toLowerCase();

  if (text.includes("海") || text.includes("うみ")) {
    return {
      reply:
        "海がお好きなんですね。ここから南へ1時間ほど走ると、若い頃によく行かれた常滑の海岸があります。夕方に着くように出発しませんか。",
      suggestedPlace: {
        id: "place-suggest-1",
        name: "野間埼灯台",
        address: "愛知県知多郡美浜町小野浦",
        location: { lat: 34.7581, lng: 136.8261 },
      },
    };
  }

  if (text.includes("思い出") || text.includes("懐かし")) {
    return {
      reply:
        "そうですね……あなたが一番よく話してくださるのは、名古屋テレビ塔の夕日のことです。もう一度、あの景色を見に行きましょうか。",
      suggestedPlace: MOCK_PLACES[0],
    };
  }

  return {
    reply:
      "なるほど。もう少し聞かせてください。その時、隣には誰がいましたか？",
  };
}
