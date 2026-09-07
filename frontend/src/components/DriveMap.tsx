"use client";

import { useEffect, useRef, useState } from "react";
import type {
  GeoJSONSource,
  MapLibreMap,
  Marker as MarkerType,
} from "maplibre-gl";
import { DEFAULT_CENTER, DEFAULT_ZOOM, MAP_STYLE } from "@/lib/mapStyle";
import type { LatLng, Place } from "@/types/api";
import "maplibre-gl/dist/maplibre-gl.css";

export type DriveMapProps = {
  /** 現在地。擬似GPSでも実GPSでも同じように扱う */
  current: LatLng | null;
  /** 訪れた場所・行きたい場所 */
  places: Place[];
  /** AIが提案した行き先。あれば強調表示してそこへ寄る */
  suggested?: Place | null;
};

/**
 * 色分け。現在地と提案地点が同じ色だと、
 * 「いまどこにいるか」と「どこへ向かうか」が見分けられなくなるので必ず変える。
 */
const COLOR = {
  current: "#2563eb", // 青：いまここ
  visited: "#059669", // 緑：訪れた場所
  suggested: "#d97706", // 琥珀：AIが提案した行き先
} as const;

/** 丸いピンを1つ作る。MapLibre は要素を渡せば何でもマーカーにできる */
function createPin(color: string, size: number, pulse = false): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `
    width:${size}px; height:${size}px; border-radius:9999px;
    background:${color}; border:3px solid #fff;
    box-shadow:0 1px 6px rgba(0,0,0,.4); cursor:pointer;
  `;
  if (pulse) {
    el.animate([{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }], {
      duration: 2000,
      iterations: Infinity,
    });
  }
  return el;
}

/** 現在地は外側に薄いハローを付けて、他のピンと明確に区別する */
function createCurrentPin(): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:relative;width:34px;height:34px;display:grid;place-items:center";

  const halo = document.createElement("div");
  halo.style.cssText = `
    position:absolute;inset:0;border-radius:9999px;
    background:${COLOR.current};opacity:.22;
  `;
  halo.animate(
    [
      { transform: "scale(.55)", opacity: 0.35 },
      { transform: "scale(1)", opacity: 0 },
    ],
    { duration: 2200, iterations: Infinity },
  );

  const dot = createPin(COLOR.current, 16);
  dot.style.position = "relative";

  wrap.append(halo, dot);
  return wrap;
}

export default function DriveMap({ current, places, suggested }: DriveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  // 地図の生成は非同期。出来上がったことを状態にしておかないと、
  // 先に走ったピン描画の効果が二度と走らず、ピンや線が出ないことがある
  const [mapReady, setMapReady] = useState(false);
  const currentMarkerRef = useRef<MarkerType | null>(null);
  const placeMarkersRef = useRef<MarkerType[]>([]);

  /* 地図の生成。マウント時に一度だけ */
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    // maplibre-gl はブラウザの機能を前提にしているので、
    // サーバー側で読み込まれないよう効果の中で取り込む
    void (async () => {
      const { Map, NavigationControl, setWorkerUrl } = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;

      // MapLibre は図形（線・多角形）の解析を Web Worker で行う。
      // バンドラー経由だと Worker の場所を解決できず、
      // 画像タイルは出るのに線やピンの図形だけ描画されない状態になる。
      // public/maplibre/ に置いた実体を明示的に指すことで回避する。
      setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

      const map = new Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        readyRef.current = true;
      });
      mapRef.current = map;
      setMapReady(true);
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      setMapReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  /* 現在地マーカー。GPSが動くたびに位置を更新する */
  useEffect(() => {
    if (!mapRef.current || !current) return;
    let cancelled = false;

    void (async () => {
      const { Marker } = await import("maplibre-gl");
      const map = mapRef.current;
      if (cancelled || !map) return;

      if (!currentMarkerRef.current) {
        currentMarkerRef.current = new Marker({
          element: createCurrentPin(),
        })
          .setLngLat([current.lng, current.lat])
          .addTo(map);
      } else {
        currentMarkerRef.current.setLngLat([current.lng, current.lat]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [current, mapReady]);

  /* 場所のピンと、訪問済みを結ぶ線 */
  useEffect(() => {
    if (!mapRef.current) return;
    let cancelled = false;

    void (async () => {
      const { Marker, Popup } = await import("maplibre-gl");
      const map = mapRef.current;
      if (cancelled || !map) return;

      // 前回のピンを消してから引き直す
      placeMarkersRef.current.forEach((m) => m.remove());
      placeMarkersRef.current = [];

      const all = suggested
        ? [...places.filter((p) => p.id !== suggested.id), suggested]
        : places;

      all.forEach((place) => {
        const isSuggested = suggested?.id === place.id;
        const marker = new Marker({
          element: createPin(
            isSuggested ? COLOR.suggested : COLOR.visited,
            isSuggested ? 24 : 16,
            isSuggested,
          ),
        })
          .setLngLat([place.location.lng, place.location.lat])
          .setPopup(
            new Popup({ offset: 16, closeButton: false }).setHTML(
              `<div style="font-family:sans-serif;padding:2px 4px;max-width:200px">
                 <strong style="font-size:14px">${place.name}</strong>
                 ${place.memory ? `<p style="margin:4px 0 0;font-size:12px;color:#555">${place.memory}</p>` : ""}
               </div>`,
            ),
          )
          .addTo(map);
        placeMarkersRef.current.push(marker);
      });

      // 訪れた場所を順に結んで「これまでの軌跡」として見せる
      const visited = places.filter((p) => p.visitedAt);
      const line = {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: visited.map((p) => [p.location.lng, p.location.lat]),
        },
      };

      const draw = () => {
        const source = map.getSource("route") as GeoJSONSource | undefined;
        if (source) {
          source.setData(line);
          return;
        }
        if (visited.length < 2) return;

        map.addSource("route", { type: "geojson", data: line });

        // 地図の背景は緑や灰色が多く、線を1本引くだけだと埋もれて見えない。
        // 白い太線を下に敷き、その上に色の線を重ねることで、
        // どんな背景でも輪郭が出るようにしている（地図でよく使われる手法）。
        map.addLayer({
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": 7,
            "line-opacity": 0.9,
          },
        });
        map.addLayer({
          id: "route",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.visited,
            "line-width": 3.5,
            "line-dasharray": [2, 1.4],
          },
        });
      };

      // スタイルの読み込み前に線を足すと落ちるので、準備できてから描く
      if (readyRef.current) draw();
      else map.once("load", draw);
    })();

    return () => {
      cancelled = true;
    };
  }, [places, suggested, mapReady]);

  /* 行き先が提案されたら、そこへ地図を寄せる */
  useEffect(() => {
    if (!mapRef.current || !suggested) return;
    mapRef.current.flyTo({
      center: [suggested.location.lng, suggested.location.lat],
      zoom: 12,
      duration: 1600,
    });
  }, [suggested]);

  return <div ref={containerRef} className="h-full w-full" />;
}
