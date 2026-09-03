"use client";

import { useEffect, useState } from "react";
import DriveMap from "@/components/DriveMap";
import { getPlaces } from "@/lib/api";
import { MOCK_USER_ID } from "@/lib/mock/data";
import { useGeolocation } from "@/hooks/useGeolocation";
import type { Place } from "@/types/api";

/**
 * 地図の単独確認用ページ。
 * 対話画面に組み込む前に、ここで地図だけを検証する。
 */
export default function MapPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [suggested, setSuggested] = useState<Place | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { location } = useGeolocation();

  useEffect(() => {
    void getPlaces(MOCK_USER_ID)
      .then((res) => setPlaces(res.places))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "場所の取得に失敗しました"),
      );
  }, []);

  return (
    <main className="flex h-dvh w-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-black/10 px-4 py-3 dark:border-white/15">
        <h1 className="text-lg font-semibold">地図（動作確認用）</h1>
        <p className="text-xs text-black/50 dark:text-white/50">
          {location
            ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
            : "位置情報なし"}
          {` / ${places.length}件`}
        </p>
      </header>

      {error && (
        <p className="bg-red-500/10 px-4 py-2 text-sm text-red-600">{error}</p>
      )}

      <div className="relative flex-1">
        <DriveMap current={location} places={places} suggested={suggested} />

        {/* 凡例。色が何を指すか分からないと地図は読めない */}
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg bg-white/90 px-3 py-2 text-xs shadow dark:bg-black/80">
          {[
            ["#2563eb", "現在地"],
            ["#059669", "訪れた場所"],
            ["#d97706", "行き先の提案"],
          ].map(([color, label]) => (
            <span key={label} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full border border-white"
                style={{ background: color }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* 対話画面に組み込む前の確認用。提案が来たときの動きを再現する */}
      <div className="flex flex-wrap gap-2 border-t border-black/10 px-4 py-3 dark:border-white/15">
        <span className="self-center text-sm text-black/50 dark:text-white/50">
          行き先の提案を再現：
        </span>
        {places.map((p) => (
          <button
            key={p.id}
            onClick={() => setSuggested(suggested?.id === p.id ? null : p)}
            className={`rounded-full px-4 py-2 text-sm ${
              suggested?.id === p.id
                ? "bg-blue-600 text-white"
                : "bg-black/5 dark:bg-white/10"
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>
    </main>
  );
}
