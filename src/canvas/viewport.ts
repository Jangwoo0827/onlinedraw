import type { Bounds } from './bounds';
import { LOGICAL_H, LOGICAL_W } from './constants';

const FIT_MARGIN = 12; // 맞춤 보기 때 화면 가장자리 여백(px)
const KEEP_VISIBLE = 80; // 이동 시 캔버스가 화면 안에 최소한 남아있어야 하는 길이(px)
const MAX_SCALE = 16;
/** 처음 입장했을 때 화면 짧은 변에 보이게 할 논리 길이 */
const HOME_SPAN = 1400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 논리 좌표 <-> 화면(CSS px) 좌표 변환.
 *   screen = logical * scale + (x, y)
 */
export class Viewport {
  scale = 1;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  private userMoved = false;
  private listeners = new Set<() => void>();

  /** 캔버스 전체가 한 화면에 들어오는 배율 */
  get fitScale() {
    const s = Math.min((this.width - FIT_MARGIN * 2) / LOGICAL_W, (this.height - FIT_MARGIN * 2) / LOGICAL_H);
    return Math.max(s, 0.001);
  }

  get minScale() {
    return this.fitScale * 0.8;
  }

  /** 지금 화면에 보이는 논리 좌표 영역 */
  visibleRect(): Bounds {
    return {
      x0: -this.x / this.scale,
      y0: -this.y / this.scale,
      x1: (this.width - this.x) / this.scale,
      y1: (this.height - this.y) / this.scale,
    };
  }

  onChange(cb: () => void) {
    this.listeners.add(cb);
  }

  screenToLogical(sx: number, sy: number): [number, number] {
    return [(sx - this.x) / this.scale, (sy - this.y) / this.scale];
  }

  /** 화면 크기가 바뀔 때(리사이즈/회전). 건드린 적 없으면 처음 보기, 아니면 화면 중심의 논리 좌표를 유지. */
  setSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    if (this.width === 0 || !this.userMoved) {
      this.width = width;
      this.height = height;
      this.resetView();
      return;
    }
    const [cx, cy] = this.screenToLogical(this.width / 2, this.height / 2);
    this.width = width;
    this.height = height;
    this.scale = clamp(this.scale, this.minScale, MAX_SCALE);
    this.x = width / 2 - cx * this.scale;
    this.y = height / 2 - cy * this.scale;
    this.clampPan();
    this.emit();
  }

  /** 처음 보기: 캔버스 한가운데를 기기 화면 크기에 맞는 적당한 배율로 */
  resetView() {
    this.scale = clamp(Math.min(this.width, this.height) / HOME_SPAN, this.minScale, 2);
    this.x = this.width / 2 - (LOGICAL_W / 2) * this.scale;
    this.y = this.height / 2 - (LOGICAL_H / 2) * this.scale;
    this.userMoved = false;
    this.emit();
  }

  /** 캔버스 전체 보기 */
  fitAll() {
    this.scale = this.fitScale;
    this.x = (this.width - LOGICAL_W * this.scale) / 2;
    this.y = (this.height - LOGICAL_H * this.scale) / 2;
    this.userMoved = true;
    this.emit();
  }

  /** 논리 좌표 (lx, ly) 가 화면 중앙에 오도록 이동. scale 을 주면 그 배율로. */
  centerOn(lx: number, ly: number, scale?: number) {
    if (scale !== undefined) this.scale = clamp(scale, this.minScale, MAX_SCALE);
    this.x = this.width / 2 - lx * this.scale;
    this.y = this.height / 2 - ly * this.scale;
    this.clampPan();
    this.userMoved = true;
    this.emit();
  }

  /** 영역 b 가 화면에 들어오도록 이동/확대 (배율은 maxScale 을 넘기지 않음) */
  focusRect(b: Bounds, maxScale = 1.5) {
    const w = Math.max(1, b.x1 - b.x0);
    const h = Math.max(1, b.y1 - b.y0);
    const s = Math.min(maxScale, (this.width - 48) / w, (this.height - 48) / h);
    this.centerOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(s, this.minScale));
  }

  /**
   * 핀치/휠용 통합 변환: (fromX, fromY) 아래에 있던 논리 좌표가 factor배 확대된 뒤 (toX, toY)로 오도록 한다.
   * 이동만 하려면 factor=1.
   */
  transform(fromX: number, fromY: number, toX: number, toY: number, factor: number) {
    const [lx, ly] = this.screenToLogical(fromX, fromY);
    this.scale = clamp(this.scale * factor, this.minScale, MAX_SCALE);
    this.x = toX - lx * this.scale;
    this.y = toY - ly * this.scale;
    this.clampPan();
    this.userMoved = true;
    this.emit();
  }

  panBy(dx: number, dy: number) {
    this.transform(0, 0, dx, dy, 1);
  }

  /** 사용자가 직접 뷰를 움직였는가 (처음 입장 후 자동 이동 여부 판단용) */
  get moved() {
    return this.userMoved;
  }

  private clampPan() {
    const pw = LOGICAL_W * this.scale;
    const ph = LOGICAL_H * this.scale;
    const loX = Math.min(KEEP_VISIBLE - pw, this.width - KEEP_VISIBLE);
    const hiX = Math.max(KEEP_VISIBLE - pw, this.width - KEEP_VISIBLE);
    const loY = Math.min(KEEP_VISIBLE - ph, this.height - KEEP_VISIBLE);
    const hiY = Math.max(KEEP_VISIBLE - ph, this.height - KEEP_VISIBLE);
    this.x = clamp(this.x, loX, hiX);
    this.y = clamp(this.y, loY, hiY);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }
}
