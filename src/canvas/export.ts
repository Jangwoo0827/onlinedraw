import { strokeBounds, union, type Bounds } from './bounds';
import { LOGICAL_H, LOGICAL_W, PAPER_COLOR } from './constants';
import { drawStroke } from './stroke-draw';
import type { Stroke } from './types';

const PAD = 60;

/** 그려진 내용 전체를 PNG 로. 내용이 없으면 null. 긴 변은 maxSide 픽셀을 넘지 않는다(작은 그림은 최대 2배로 선명하게). */
export function exportPng(strokes: readonly Stroke[], maxSide = 3000): Promise<Blob | null> {
  let b: Bounds | null = null;
  for (const s of strokes) b = union(b, strokeBounds(s));
  if (!b) return Promise.resolve(null);
  const x0 = Math.max(0, b.x0 - PAD);
  const y0 = Math.max(0, b.y0 - PAD);
  const x1 = Math.min(LOGICAL_W, b.x1 + PAD);
  const y1 = Math.min(LOGICAL_H, b.y1 + PAD);
  const w = x1 - x0;
  const h = y1 - y0;
  const k = Math.min(2, maxSide / Math.max(w, h));
  const width = Math.max(1, Math.round(w * k));
  const height = Math.max(1, Math.round(h * k));

  // 지우개가 동작하도록 투명 레이어에 먼저 그리고, 흰 종이 위에 합친다
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const lc = layer.getContext('2d')!;
  lc.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  for (const s of strokes) drawStroke(lc, s, false, 1 / k);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const oc = out.getContext('2d')!;
  oc.fillStyle = PAPER_COLOR;
  oc.fillRect(0, 0, width, height);
  oc.drawImage(layer, 0, 0);
  return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
