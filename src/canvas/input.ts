import { serverNow } from '../sync/clock';
import { MAX_POINTS_PER_STROKE } from './constants';
import type { Renderer } from './renderer';
import { simplify } from './simplify';
import type { StrokeStore } from './store';
import type { ToolState } from './tool-state';
import type { Point, Stroke } from './types';
import type { Viewport } from './viewport';

/** 새 점을 받아들이는 최소 화면 간격(CSS px) */
const MIN_POINT_DIST_PX = 1.2;

/** 충돌 가능성이 낮고, http(비보안 컨텍스트)에서도 동작하는 ID 생성 (crypto.randomUUID 는 https 전용) */
export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 동기화 계층이 내 획의 생애주기를 받아볼 수 있게 하는 훅 */
export interface StrokeHooks {
  start(stroke: Stroke): void;
  /** 점이 추가될 때마다 호출. 전송 간격 조절은 받는 쪽 책임 */
  extend(stroke: Stroke): void;
  /** 단순화가 끝나 store 에 확정된 직후 */
  finish(stroke: Stroke): void;
  cancel(stroke: Stroke): void;
}

interface Pt {
  x: number;
  y: number;
}

/**
 * Pointer Events 기반 입력.
 *  - 마우스/펜/한 손가락: 그리기
 *  - 두 손가락(터치): 이동 + 핀치 줌. 그리는 중 두 번째 손가락이 닿으면 그 획은 취소.
 *  - 마우스: 휠 줌, 가운데/오른쪽 버튼 드래그 또는 Space+드래그로 이동
 */
export class CanvasInput {
  private touches = new Map<number, Pt>(); // 터치 포인터별 현재 위치(캔버스 기준 CSS px)
  private gesture: { ids: [number, number]; cx: number; cy: number; dist: number } | null = null;
  /** 제스처를 한 번 시작하면 모든 손가락을 뗄 때까지 남은 손가락으로 그리지 않는다 */
  private touchLocked = false;

  private stroke: Stroke | null = null;
  private drawingId: number | null = null;
  private drawingType = '';
  private smoothedPressure = 0.5;

  private panId: number | null = null;
  private panLast: Pt = { x: 0, y: 0 };
  private spaceDown = false;
  private rect: DOMRect;
  hooks: StrokeHooks | null = null;
  /** false 면(보기 전용/획 한도) 그리지 않고, 한 손가락/마우스 드래그가 화면 이동이 된다 */
  drawEnabled = true;
  /** 내 커서/손가락 위치(논리 좌표)를 알려준다. leave: 캔버스를 벗어남 */
  onCursor: ((x: number, y: number) => void) | null = null;
  onCursorLeave: (() => void) | null = null;
  private touchPanId: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private tools: ToolState,
    private store: StrokeStore,
    private renderer: Renderer,
  ) {
    this.rect = canvas.getBoundingClientRect();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', (e) => this.onUp(e, false));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e, true));
    canvas.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && this.onCursorLeave?.());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

    // 브라우저 기본 동작 차단: 길게 누르기 메뉴, 선택, iOS 핀치 확대, 더블탭 확대
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    document.addEventListener('selectstart', block);
    document.addEventListener('gesturestart', block);
    document.addEventListener('gesturechange', block);
    canvas.addEventListener('touchstart', block, { passive: false });
    canvas.addEventListener('touchmove', block, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isEditable(e.target) && !(e.target instanceof HTMLButtonElement)) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    window.addEventListener('blur', () => (this.spaceDown = false));
  }

  // ---------- 포인터 이벤트 ----------

  private onDown = (e: PointerEvent) => {
    this.rect = this.canvas.getBoundingClientRect();
    e.preventDefault();

    if (e.pointerType === 'touch') {
      if (this.drawingType === 'pen') return; // 펜으로 그리는 중 손바닥 터치 무시
      this.touches.set(e.pointerId, this.local(e));
      this.canvas.setPointerCapture(e.pointerId);
      if (this.touches.size >= 2) {
        this.cancelStroke();
        this.touchPanId = null;
        this.touchLocked = true;
        this.startGesture();
      } else if (!this.touchLocked) {
        if (this.drawEnabled) this.beginStroke(e);
        else this.touchPanId = e.pointerId; // 보기 전용: 한 손가락으로 이동
      }
      return;
    }

    // 마우스 / 펜
    const wantsPan =
      e.pointerType === 'mouse' &&
      (e.button === 1 || e.button === 2 || (e.button === 0 && (this.spaceDown || !this.drawEnabled)));
    if (wantsPan) {
      this.panId = e.pointerId;
      this.panLast = this.local(e);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (!this.drawEnabled) return;
    if (this.drawingId !== null) this.cancelStroke(); // 펜이 터치 획을 대체
    this.canvas.setPointerCapture(e.pointerId);
    this.beginStroke(e);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (!this.touches.has(e.pointerId)) return;
      const prev = this.touches.get(e.pointerId)!;
      const cur = this.local(e);
      this.touches.set(e.pointerId, cur);
      if (this.gesture) {
        this.updateGesture();
      } else if (e.pointerId === this.touchPanId) {
        this.viewport.panBy(cur.x - prev.x, cur.y - prev.y);
      } else if (e.pointerId === this.drawingId) {
        this.extendStroke(e);
        this.reportCursor(e);
      }
      return;
    }
    if (e.pointerId === this.panId) {
      const p = this.local(e);
      this.viewport.panBy(p.x - this.panLast.x, p.y - this.panLast.y);
      this.panLast = p;
    } else if (e.pointerId === this.drawingId) {
      this.extendStroke(e);
      this.reportCursor(e);
    } else if (e.pointerType === 'mouse') {
      this.rect = this.canvas.getBoundingClientRect();
      this.reportCursor(e); // 마우스는 누르지 않고 움직일 때도 위치를 알린다
    }
  };

  private reportCursor(e: PointerEvent) {
    if (!this.onCursor) return;
    const [x, y] = this.viewport.screenToLogical(e.clientX - this.rect.left, e.clientY - this.rect.top);
    this.onCursor(x, y);
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    if (e.pointerType === 'touch') {
      if (!this.touches.delete(e.pointerId)) return;
      if (e.pointerId === this.touchPanId) this.touchPanId = null;
      if (e.pointerId === this.drawingId) {
        if (cancelled) this.cancelStroke();
        else this.finishStroke(e);
      }
      if (this.gesture?.ids.includes(e.pointerId)) {
        if (this.touches.size >= 2) this.startGesture();
        else this.gesture = null;
      }
      if (this.touches.size === 0) this.touchLocked = false;
      return;
    }
    if (e.pointerId === this.panId) {
      this.panId = null;
    } else if (e.pointerId === this.drawingId) {
      if (cancelled) this.cancelStroke();
      else this.finishStroke(e);
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.rect = this.canvas.getBoundingClientRect();
    const p = this.local(e);
    const isMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    if (e.ctrlKey || e.metaKey) {
      // 트랙패드 핀치(ctrlKey 로 들어옴) / Ctrl+휠
      this.viewport.transform(p.x, p.y, p.x, p.y, Math.exp(-e.deltaY * 0.01));
    } else if (isMouseWheel) {
      this.viewport.transform(p.x, p.y, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    } else {
      this.viewport.panBy(-e.deltaX, -e.deltaY); // 트랙패드 두 손가락 스크롤
    }
  };

  // ---------- 제스처 (이동 + 핀치) ----------

  private startGesture() {
    const [a, b] = [...this.touches.keys()];
    const m = this.measure(a, b);
    this.gesture = { ids: [a, b], ...m };
  }

  private updateGesture() {
    const g = this.gesture!;
    const m = this.measure(g.ids[0], g.ids[1]);
    if (g.dist > 0 && m.dist > 0) {
      this.viewport.transform(g.cx, g.cy, m.cx, m.cy, m.dist / g.dist);
    }
    g.cx = m.cx;
    g.cy = m.cy;
    g.dist = m.dist;
  }

  private measure(a: number, b: number) {
    const p = this.touches.get(a)!;
    const q = this.touches.get(b)!;
    return { cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2, dist: Math.hypot(p.x - q.x, p.y - q.y) };
  }

  // ---------- 그리기 ----------

  private beginStroke(e: PointerEvent) {
    const stroke: Stroke = {
      id: newId(),
      uid: this.store.uid,
      color: this.tools.color,
      size: this.tools.size,
      tool: this.tools.tool,
      points: [],
      createdAt: serverNow(),
    };
    this.stroke = stroke;
    this.drawingId = e.pointerId;
    this.drawingType = e.pointerType;
    this.smoothedPressure = hasPressure(e) ? e.pressure : 0.5;
    stroke.points.push(this.toPoint(e));
    // 화면에는 첫 이동/떼는 시점에 처음 그린다(두 번째 손가락이 바로 닿는 핀치 시작 시 깜빡임 방지)
    this.renderer.beginStroke(stroke);
    this.hooks?.start(stroke);
  }

  private extendStroke(e: PointerEvent) {
    const stroke = this.stroke!;
    const prevLen = stroke.points.length;
    const events = e.getCoalescedEvents?.();
    for (const ev of events && events.length ? events : [e]) this.pushPoint(stroke, ev, false);
    if (stroke.points.length > prevLen) {
      this.renderer.strokeExtended(stroke, prevLen);
      this.hooks?.extend(stroke);
    }
    // 획 하나가 너무 길어지면(서버 규칙의 포인트 상한) 여기서 끝내고 같은 지점에서 새 획으로 이어서 그린다
    if (stroke.points.length >= MAX_POINTS_PER_STROKE) {
      this.finishStroke(e);
      this.beginStroke(e);
    }
  }

  private finishStroke(e: PointerEvent) {
    const stroke = this.stroke!;
    const prevLen = stroke.points.length;
    this.pushPoint(stroke, e, true);
    if (stroke.points.length > prevLen) this.renderer.strokeExtended(stroke, prevLen);
    this.renderer.strokeFinished(stroke);
    // 획이 끝나면 점을 줄인다. 허용 오차는 화면에서 약 0.5px 이내(너무 확대해 그린 획은 더 촘촘하게 유지)
    stroke.points = simplify(stroke.points, Math.min(1, Math.max(0.1, 0.5 / this.viewport.scale)));
    this.store.add(stroke);
    this.hooks?.finish(stroke);
    this.resetDrawing();
  }

  private cancelStroke() {
    if (!this.stroke) return;
    this.renderer.strokeCancelled();
    this.hooks?.cancel(this.stroke);
    this.resetDrawing();
  }

  private resetDrawing() {
    this.stroke = null;
    this.drawingId = null;
    this.drawingType = '';
  }

  /** 너무 가까운 점은 버린다. force=true(획의 마지막 점)면 마지막 점과 달라질 때 항상 추가. */
  private pushPoint(stroke: Stroke, e: PointerEvent, force: boolean) {
    const pt = this.toPoint(e);
    const last = stroke.points[stroke.points.length - 1];
    const d = Math.hypot(pt[0] - last[0], pt[1] - last[1]) * this.viewport.scale;
    if (d === 0 || (!force && d < MIN_POINT_DIST_PX)) return;
    stroke.points.push(pt);
  }

  private toPoint(e: PointerEvent): Point {
    const [x, y] = this.viewport.screenToLogical(e.clientX - this.rect.left, e.clientY - this.rect.top);
    const pt: Point = [round1(x), round1(y)];
    if (hasPressure(e)) {
      this.smoothedPressure = this.smoothedPressure * 0.5 + e.pressure * 0.5;
      pt.push(Math.round(this.smoothedPressure * 100) / 100);
    }
    return pt;
  }

  private local(e: { clientX: number; clientY: number }): Pt {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }
}

/** 필압을 믿을 수 있는 입력인가: 펜(스타일러스)만 인정. 마우스는 0.5 고정, 터치는 기기마다 값이 제각각이라 제외. */
function hasPressure(e: PointerEvent) {
  return e.pointerType === 'pen' && e.pressure > 0;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function isEditable(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}
