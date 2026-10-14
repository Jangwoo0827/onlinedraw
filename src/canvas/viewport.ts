import { LOGICAL_H, LOGICAL_W } from './constants';

const FIT_MARGIN = 12; // 맞춤 보기 때 화면 가장자리 여백(px)
const KEEP_VISIBLE = 80; // 이동 시 캔버스가 화면 안에 최소한 남아있어야 하는 길이(px)
const MAX_SCALE = 12;

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

  get fitScale() {
    const s = Math.min(
      (this.width - FIT_MARGIN * 2) / LOGICAL_W,
      (this.height - FIT_MARGIN * 2) / LOGICAL_H,
    );
    return Math.max(s, 0.01);
  }

  get minScale() {
    return this.fitScale * 0.5;
  }

  onChange(cb: () => void) {
    this.listeners.add(cb);
  }

  screenToLogical(sx: number, sy: number): [number, number] {
    return [(sx - this.x) / this.scale, (sy - this.y) / this.scale];
  }

  /** 화면 크기가 바뀔 때(리사이즈/회전). 건드린 적 없으면 맞춤, 아니면 화면 중심의 논리 좌표를 유지. */
  setSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    if (this.width === 0 || !this.userMoved) {
      this.width = width;
      this.height = height;
      this.fit();
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

  /** 캔버스 전체가 보이도록 맞춤 */
  fit() {
    this.scale = this.fitScale;
    this.x = (this.width - LOGICAL_W * this.scale) / 2;
    this.y = (this.height - LOGICAL_H * this.scale) / 2;
    this.userMoved = false;
    this.emit();
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
