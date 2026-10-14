import type { Stroke } from './types';

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const cache = new WeakMap<Stroke, Bounds>();

/** 획이 차지하는 논리 좌표 영역(선 굵기 포함). 확정된 획은 점이 바뀌지 않으므로 한 번만 계산해 캐시한다. */
export function strokeBounds(s: Stroke): Bounds {
  let b = cache.get(s);
  if (b) return b;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.points) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const pad = s.size * 0.85 + 1; // 필압으로 최대 1.7배까지 굵어진다
  b = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  cache.set(s, b);
  return b;
}

export const intersects = (a: Bounds, b: Bounds) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

export function union(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
