import type { Point, Stroke, Tool } from '../canvas/types';

/**
 * 포인트 배열 <-> 문자열. "x,y;x,y,p;..." (필압이 있으면 세 번째 값).
 * Realtime Database 는 배열을 인덱스 키 객체로 저장해서 용량이 커지므로 문자열 하나로 보낸다.
 */
export function encodePoints(points: readonly Point[]): string {
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i) out += ';';
    out += p[0] + ',' + p[1];
    if (p[2] !== undefined) out += ',' + p[2];
  }
  return out;
}

export function decodePoints(text: unknown): Point[] {
  if (typeof text !== 'string' || text === '') return [];
  const points: Point[] = [];
  for (const part of text.split(';')) {
    const v = part.split(',');
    const x = Number(v[0]);
    const y = Number(v[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (v.length > 2) {
      const p = Number(v[2]);
      points.push(Number.isFinite(p) ? [x, y, p] : [x, y]);
    } else {
      points.push([x, y]);
    }
  }
  return points;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 서버에서 받은 획 헤더(진행 중이면 points 없음)를 검증해서 Stroke 로 만든다. 이상한 값이면 null. */
export function parseStroke(id: string, v: unknown, points: Point[]): Stroke | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const tool: Tool | null = o.tool === 'pen' || o.tool === 'eraser' ? o.tool : null;
  if (!tool || typeof o.uid !== 'string') return null;
  const size = Number(o.size);
  if (!Number.isFinite(size) || size <= 0 || size > 200) return null;
  const color = typeof o.color === 'string' && COLOR_RE.test(o.color) ? o.color : '#000000';
  const createdAt = typeof o.createdAt === 'number' ? o.createdAt : Date.now();
  return { id, uid: o.uid, color, size, tool, points, createdAt };
}
