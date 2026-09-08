/**
 * ブラウザ機能の有無を調べるための小道具。
 *
 * `navigator` や `window` はサーバー側の描画時には存在しないため、
 * 効果の中で調べて setState する書き方をしがちだが、それは余計な再描画を招く。
 * useSyncExternalStore に渡すことで、サーバー用とクライアント用の値を
 * 再描画なしに出し分けられる。
 */

/** 対応状況は途中で変わらないので、購読しても何も起きない */
export function subscribeNever(): () => void {
  return () => {};
}
