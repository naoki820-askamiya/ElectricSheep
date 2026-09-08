"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { subscribeNever } from "@/lib/browser";
import type { LatLng } from "@/types/api";

/**
 * 現在地を取得するフック。
 *
 * デモ形式が「実車」と「室内」の両方あり得るので、環境変数で切り替えられるようにしてある。
 *   .env.local に NEXT_PUBLIC_USE_MOCK_GPS=true と書くと、
 *   実際のGPSを使わず名古屋周辺を擬似的に移動する。
 *
 * なおREADMEの3層構成では、位置情報を取得するのはスマートフォンの役目。
 * 車載デバイス（ラズパイ）はここを使わず、Bluetooth経由で座標を受け取る想定。
 */
const USE_MOCK_GPS = process.env.NEXT_PUBLIC_USE_MOCK_GPS === "true";

/** モックGPSの出発地点（名古屋テレビ塔） */
const MOCK_START: LatLng = { lat: 35.1721, lng: 136.9086 };

export type GeolocationState = {
  location: LatLng | null;
  error: string | null;
  /** まだ一度も位置を取得できていない間は true */
  loading: boolean;
};

export function useGeolocation(): GeolocationState {
  const available = useSyncExternalStore(
    subscribeNever,
    () => "geolocation" in navigator,
    () => true, // サーバー描画時は使える前提にしておく
  );

  // 擬似GPSは環境変数で決まる（ビルド時に確定する）ので初期値として置ける
  const [location, setLocation] = useState<LatLng | null>(
    USE_MOCK_GPS ? MOCK_START : null,
  );
  const [watchError, setWatchError] = useState<string | null>(null);

  useEffect(() => {
    // --- モードA: 擬似GPS（室内デモ用）---
    if (USE_MOCK_GPS) {
      let step = 0;

      // 3秒ごとに少しずつ南へ動かして「走っている」ように見せる
      const timer = setInterval(() => {
        step += 1;
        setLocation({
          lat: MOCK_START.lat - step * 0.002,
          lng: MOCK_START.lng + step * 0.0005,
        });
      }, 3000);

      return () => clearInterval(timer);
    }

    // --- モードB: 実GPS（実車デモ用）---
    if (!available) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setWatchError(null);
      },
      (err) => {
        // HTTPSでないと本番ブラウザでは必ず失敗する点に注意
        setWatchError(`位置情報を取得できません: ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [available]);

  // 状態から導けるものは state に持たない
  const error =
    !USE_MOCK_GPS && !available
      ? "この端末では位置情報が使えません"
      : watchError;

  const loading =
    !USE_MOCK_GPS && available && location === null && watchError === null;

  return { location, error, loading };
}
