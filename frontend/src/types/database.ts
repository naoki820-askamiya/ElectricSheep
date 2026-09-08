// 場所そのものを表す型
export type Place = {
    id: string;
    name: string;
    address?: string;
    memory?: string;
    visitedAt?: string; // ← 追加
    location: {
        lat: number;
        lng: number;
    };
    isFavorite?: boolean;          // ← ? を追加
    isWishlist?: boolean;          // ← ? を追加
    visitCount?: number;           // ← ? を追加
    lastVisitedAt?: string | null; // ← ? を追加
    createdAt?: string;            // ← ? を追加
};

// その場所を訪れた出来事と思い出を表す型
export type Visit = {
  id: string;
  placeId: string;
  visitedAt: string;
  companions: string[];
  conversationSummary: string;
  mood: string;
  isDetour: boolean;
  notableEvent: string;
  createdAt: string;
};