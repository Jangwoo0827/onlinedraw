import type { Stroke } from './types';

/** 필압 p(0..1) -> 굵기 배율. p=0.5가 1배. */
const widthAt = (s: Stroke, i: number) => {
  const p = s.points[i][2];
  return s.size * (p === undefined ? 1 : 0.3 + 1.4 * p);
};

function applyStyle(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'eraser') {
    // 획 레이어 위에서만 지운다(종이는 별도). 지우개도 하나의 획으로 기록된다.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = ctx.fillStyle = '#000';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = ctx.fillStyle = s.color;
  }
}

/**
 * i번째 점에 대응하는 구간을 그린다. 이전/다음 점과의 중간점 사이를 i번째 점을 제어점으로 하는
 * 2차 곡선으로 이어서 부드럽게 만든다. 마지막 점(i === n-1)은 끝점이 실제 마지막 점이다.
 * 점이 새로 추가될 때 (새 점 인덱스 - 1)번 구간만 그리면 증분 렌더링이 되고,
 * 획이 끝날 때 마지막 구간을 그리면 전체 다시 그리기와 결과가 같아진다.
 */
export function drawSegment(ctx: CanvasRenderingContext2D, s: Stroke, i: number) {
  const pts = s.points;
  const n = pts.length;
  const p = pts[i];
  const sx = i === 0 ? p[0] : (pts[i - 1][0] + p[0]) / 2;
  const sy = i === 0 ? p[1] : (pts[i - 1][1] + p[1]) / 2;
  const ex = i === n - 1 ? p[0] : (p[0] + pts[i + 1][0]) / 2;
  const ey = i === n - 1 ? p[1] : (p[1] + pts[i + 1][1]) / 2;
  applyStyle(ctx, s);
  ctx.lineWidth = widthAt(s, i);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(p[0], p[1], ex, ey);
  ctx.stroke();
}

/** 점 하나짜리 획(탭) */
export function drawDot(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.points[0];
  applyStyle(ctx, s);
  ctx.beginPath();
  ctx.arc(p[0], p[1], widthAt(s, 0) / 2, 0, Math.PI * 2);
  ctx.fill();
}

/** 획 전체 그리기 (확정된 획, 또는 진행 중인 획의 현재까지) */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const n = s.points.length;
  if (n === 0) return;
  if (n === 1) {
    drawDot(ctx, s);
    return;
  }
  for (let i = 0; i < n; i++) drawSegment(ctx, s, i);
}
