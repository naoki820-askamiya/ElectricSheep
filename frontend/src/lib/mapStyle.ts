import type { StyleSpecification } from "maplibre-gl";

/**
 * 地図の見た目の定義（スタイル）。
 *
 * MapLibre は地図の絵そのものを持っていないので、どこから画像を取ってくるかを教える必要がある。
 * ここでは OpenStreetMap を使っている。APIキーも課金登録も不要なのが選定理由。
 *
 * 注意: OpenStreetMap の公式タイルは本来アプリでの常用を想定していない。
 * ハッカソンのデモ程度なら問題ない範囲だが、本格運用するなら
 * 無料キーを取れる配信元（MapTiler 等）に差し替えること。差し替えはこのファイルだけで済む。
 */
export const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm",
    },
  ],
};

/** 地図の初期表示位置（名古屋テレビ塔） */
export const DEFAULT_CENTER: [number, number] = [136.9086, 35.1721];
export const DEFAULT_ZOOM = 11;
