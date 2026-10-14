import { BACKDROP_COLOR, LOGICAL_H, LOGICAL_W, PAPER_COLOR } from './constants';
import { drawDot, drawSegment, drawStroke } from './stroke-draw';
import type { StrokeStore } from './store';
import type { Stroke } from './types';
import type { Viewport } from './viewport';

/**
 * 렌더링:
 *  - layer(오프스크린): 획만 그려진 투명 레이어. 지우개는 여기서 destination-out 으로 동작.
 *  - display: 배경 + 종이 + layer 를 합성한 화면용 캔버스.
 * 뷰가 바뀌면 layer 를 전체 다시 그리고, 새 점이 추가될 때는 그 구간만 layer 에 덧그린다.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement('canvas');
  private layerCtx: CanvasRenderingContext2D;
  private dpr = 1;
  private layerDirty = true;
  private raf = 0;
  private active: Stroke | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private store: StrokeStore,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.layerCtx = this.layer.getContext('2d')!;
    viewport.onChange(() => this.invalidate());
    // 'add'는 입력 쪽에서 이미 증분으로 그려져 있으므로 undo/redo 때만 전체 다시 그린다
    store.onChange((event) => {
      if (event !== 'add') this.invalidate();
    });
  }

  /** cssW/cssH: CSS px 크기 */
  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(dpr, 3);
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.width = this.layer.width = w;
    this.canvas.height = this.layer.height = h;
    this.viewport.setSize(cssW, cssH);
    this.invalidate();
  }

  /** 레이어 전체 다시 그리기 예약 */
  invalidate() {
    this.layerDirty = true;
    this.schedule();
  }

  // ---- 진행 중인 획 (증분 렌더링) ----

  beginStroke(stroke: Stroke) {
    this.active = stroke;
  }

  /** prevLen 이후로 점이 추가되었을 때, 새로 생긴 구간만 레이어에 덧그린다. */
  strokeExtended(stroke: Stroke, prevLen: number) {
    if (this.layerDirty) return; // 다음 프레임의 전체 다시 그리기가 포함한다
    this.setLayerTransform();
    for (let k = Math.max(1, prevLen); k < stroke.points.length; k++) {
      drawSegment(this.layerCtx, stroke, k - 1);
    }
    this.schedule();
  }

  /** 획 종료: 마지막 구간(또는 점 하나짜리 획)을 마저 그린다. */
  strokeFinished(stroke: Stroke) {
    this.active = null;
    if (this.layerDirty) return;
    this.setLayerTransform();
    const n = stroke.points.length;
    if (n === 1) drawDot(this.layerCtx, stroke);
    else if (n > 1) drawSegment(this.layerCtx, stroke, n - 1);
    this.schedule();
  }

  /** 획 취소: 레이어에서 지워야 하므로 전체 다시 그리기 */
  strokeCancelled() {
    this.active = null;
    this.invalidate();
  }

  // ---- 내부 ----

  private setLayerTransform() {
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    this.layerCtx.setTransform(d * scale, 0, 0, d * scale, d * x, d * y);
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (this.layerDirty) this.redrawLayer();
    this.compose();
  };

  private redrawLayer() {
    this.layerDirty = false;
    const c = this.layerCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.layer.width, this.layer.height);
    this.setLayerTransform();
    for (const s of this.store.strokes) drawStroke(c, s);
    if (this.active) drawStroke(c, this.active);
  }

  private compose() {
    const c = this.ctx;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = BACKDROP_COLOR;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 종이(그림자 포함)
    c.save();
    c.setTransform(d * scale, 0, 0, d * scale, d * x, d * y);
    c.shadowColor = 'rgba(0,0,0,0.18)';
    c.shadowBlur = 12 * d;
    c.shadowOffsetY = 2 * d;
    c.fillStyle = PAPER_COLOR;
    c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    c.restore();

    // 획 레이어: 종이 영역 밖은 잘라낸다
    c.save();
    c.beginPath();
    c.rect(d * x, d * y, d * scale * LOGICAL_W, d * scale * LOGICAL_H);
    c.clip();
    c.drawImage(this.layer, 0, 0);
    c.restore();
  }
}
