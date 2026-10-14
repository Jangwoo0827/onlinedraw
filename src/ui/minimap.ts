import { LOGICAL_H, LOGICAL_W } from '../canvas/constants';
import type { Renderer } from '../canvas/renderer';
import type { Viewport } from '../canvas/viewport';

const SIZE = 96; // CSS px

/** 판이 아주 크므로 전체 그림(overview)과 지금 보고 있는 영역을 작게 보여주고, 누르면 그 위치로 이동한다. */
export function mountMinimap(stage: HTMLElement, renderer: Renderer, viewport: Viewport) {
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap';
  canvas.setAttribute('aria-label', '미니맵 (눌러서 이동)');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(SIZE * dpr);
  stage.append(canvas);
  const ctx = canvas.getContext('2d')!;

  const draw = () => {
    const w = canvas.width;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, w);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(renderer.getOverviewCanvas(), 0, 0, w, w);
    const v = viewport.visibleRect();
    const k = w / LOGICAL_W; // 가로세로가 같은 정사각 판
    const x0 = Math.max(0, v.x0) * k;
    const y0 = Math.max(0, v.y0) * k;
    const x1 = Math.min(LOGICAL_W, v.x1) * k;
    const y1 = Math.min(LOGICAL_H, v.y1) * k;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#3b6cf6';
    ctx.fillStyle = 'rgba(59,108,246,0.15)';
    const rw = Math.max(4 * dpr, x1 - x0);
    const rh = Math.max(4 * dpr, y1 - y0);
    ctx.fillRect(x0, y0, rw, rh);
    ctx.strokeRect(x0, y0, rw, rh);
  };
  renderer.onFrame(draw);
  viewport.onChange(draw);

  const jump = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    viewport.centerOn(fx * LOGICAL_W, fy * LOGICAL_H);
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    jump(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (canvas.hasPointerCapture(e.pointerId)) jump(e);
  });
  draw();
  return { draw };
}
