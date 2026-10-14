import { strokeBounds, type Bounds } from './bounds';
import { BACKDROP_COLOR, LOGICAL_H, LOGICAL_W, PAPER_BORDER, PAPER_COLOR } from './constants';
import { StrokeCache } from './stroke-cache';
import type { StrokeStore } from './store';
import type { Stroke } from './types';
import type { Viewport } from './viewport';

/** overview 캐시의 긴 변 픽셀 수. 판이 아무리 커도 전체를 이 크기의 저해상도 그림으로 항상 최신 상태로 유지한다. */
const OVERVIEW_PX = 2048;
const OVERVIEW_SCALE = Math.min(1.5, OVERVIEW_PX / Math.max(LOGICAL_W, LOGICAL_H));
/** detail 캔버스는 화면보다 이만큼 크게 만들어, 조금 움직일 때는 다시 그리지 않고 평행 이동만 한다. */
const OVERSCAN = 1.5;
/** 뷰 변화가 멈춘 뒤 detail 을 다시 그리기까지의 대기 시간 */
const SETTLE_MS = 120;

/**
 * 레이어 구성 (확정된 획은 한 번 그려 캐싱해 두고, 프레임마다는 합성만 한다)
 *
 *  overview : 판 전체의 확정 획을 저해상도(OVERVIEW_SCALE)로. 뷰와 무관해서 이동/줌 중에도, 멀리서 볼 때도 항상 쓸 수 있다.
 *  detail   : 현재 배율로 정확히 그린 확정 획. 화면의 1.5배 영역을 덮는다(보이는 영역과 겹치는 획만 그림).
 *             뷰가 멈추면 시간을 쪼개 뒷버퍼에 다시 그려 완성되면 교체한다. 덮지 못하는 곳은 overview 가 대신 보인다.
 *  live     : 지금 그리고 있는 내 획 하나(증분). 지우개 획은 모양만 담고 합성 때 아래 레이어를 지운다.
 *  remote   : 다른 참가자가 지금 그리고 있는 획들(증분, 펜만).
 *
 * 확정된 획이 늘어날 때는 overview/detail 에 그 획만 덧그리고, 취소/삭제/순서 변경은 그 획의 영역만 다시 그린다.
 * 전체 다시 그리기(renderAll)는 전체 지우기 같은 경우에만 쓴다.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private overview = this.newOverview();
  private detail = new StrokeCache();
  private detailBack = new StrokeCache();
  private detailReady = false;
  private detailBuilding = false;
  private detailGen = 0; // 진행 중인 detail 렌더링을 취소하기 위한 세대 번호
  private overviewGen = 0;
  private overviewBusy = false;
  private live = new StrokeCache(true);
  private remoteLive = new StrokeCache();
  private remoteActive = new Map<string, Stroke>();
  private remoteDirty = false;
  private scratch: HTMLCanvasElement | null = null; // 지우개 획이 진행 중일 때만 쓰는 합성용 버퍼

  private active: Stroke | null = null;
  private liveDirty = false;
  private raf = 0;
  private settleTimer = 0;
  private frameListeners = new Set<() => void>();

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private store: StrokeStore,
  ) {
    this.ctx = canvas.getContext('2d')!;

    viewport.onChange(() => this.onViewChanged());
    store.onChange((event, stroke) => {
      if (event === 'history' || !stroke) return;
      if (event === 'add' || event === 'redo') this.drawCommitted(stroke); // 끝에 추가: 그 획만 덧그린다
      else if (event === 'reset') this.renderAll();
      else this.redrawStrokeRegion(strokeBounds(stroke)); // undo / remove / reorder: 그 획의 영역만
    });
  }

  /** 합성이 끝날 때마다 호출 (미니맵 등) */
  onFrame(cb: () => void) {
    this.frameListeners.add(cb);
  }

  getOverviewCanvas() {
    return this.overview.canvas;
  }

  /** cssW/cssH: CSS px 크기 */
  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(dpr, 3);
    const w = cssW * this.dpr;
    const h = cssH * this.dpr;
    this.canvas.width = Math.max(1, Math.round(w));
    this.canvas.height = Math.max(1, Math.round(h));
    this.detail.resize(w * OVERSCAN, h * OVERSCAN);
    this.detailBack.resize(w * OVERSCAN, h * OVERSCAN);
    this.detailReady = false;
    this.live.resize(w, h);
    this.remoteLive.resize(w, h);
    this.scratch = null;
    this.viewport.setSize(cssW, cssH);
    this.onViewChanged();
  }

  /** overview/detail 이 모두 최신이고 시간을 나눠 진행 중인 작업이 없는가 (테스트/디버그용) */
  get settled() {
    return !this.overviewBusy && !this.detailBuilding && (!this.useDetail() || this.detailReady);
  }

  /**
   * 전체 다시 그리기: 확정된 획 전체로 overview 를 새로 만들고(뒷버퍼에 시간을 나눠 그린 뒤 교체),
   * 이어서 detail 도 다시 만든다. 전체 지우기 등 여러 획이 한꺼번에 바뀔 때만 쓴다.
   */
  renderAll() {
    this.detailGen++;
    this.detailReady = false; // 낡은 detail 은 즉시 버린다
    this.detailBuilding = false;
    const gen = ++this.overviewGen;
    this.overviewBusy = true;
    const next = this.newOverview();
    next.renderSliced(
      this.store.strokes,
      () => gen !== this.overviewGen,
      () => {
        this.overview = next;
        this.overviewBusy = false;
        this.rebuildDetail();
        this.schedule();
      },
    );
  }

  private newOverview() {
    const cache = new StrokeCache();
    cache.resize(LOGICAL_W * OVERVIEW_SCALE, LOGICAL_H * OVERVIEW_SCALE);
    cache.setView(OVERVIEW_SCALE, 0, 0);
    return cache;
  }

  // ---- 진행 중인 획 (live 레이어, 증분) ----

  beginStroke(stroke: Stroke) {
    this.active = stroke;
    this.liveDirty = true; // 첫 합성 때 live 의 뷰 변환을 맞춘다
  }

  /** prevLen 이후로 점이 추가되었을 때, 새로 생긴 구간만 live 에 덧그린다. */
  strokeExtended(stroke: Stroke, prevLen: number) {
    if (!this.liveDirty) this.live.drawSegmentsFrom(stroke, prevLen); // dirty 면 다음 합성 때 점 전체로 다시 그린다
    this.schedule();
  }

  /** 획 종료: live 를 비운다. 확정된 획은 store.add 의 'add' 이벤트에서 overview/detail 에 그려진다. */
  strokeFinished(_stroke: Stroke) {
    this.endActive();
  }

  /** 획 취소: live 만 비우면 되고 확정된 획은 다시 그리지 않는다. */
  strokeCancelled() {
    this.endActive();
  }

  // ---- 다른 참가자의 진행 중인 획 (remote 레이어, 증분) ----

  beginRemote(stroke: Stroke) {
    this.remoteActive.set(stroke.id, stroke);
    this.remoteDirty = true;
    this.schedule();
  }

  /** prevLen 이후로 점이 추가됨. 지우개 획은 확정되기 전에는 보여주지 않는다. */
  remoteExtended(stroke: Stroke, prevLen: number) {
    if (!this.remoteActive.has(stroke.id)) return;
    if (!this.remoteDirty && stroke.tool === 'pen') this.remoteLive.drawSegmentsFrom(stroke, prevLen);
    this.schedule();
  }

  /** 진행 중 표시를 걷어낸다(확정되었거나 취소됨). 남은 획만 다시 그리므로 비용은 진행 중인 획 분량뿐. */
  endRemote(id: string) {
    if (this.remoteActive.delete(id)) {
      this.remoteDirty = true;
      this.schedule();
    }
  }

  // ---- 확정된 획 ----

  private drawCommitted(stroke: Stroke) {
    this.overview.drawStroke(stroke);
    // detail 이 만들어지는 중이면 store.strokes 를 순회하는 쪽이 이 획도 그려준다
    if (this.detailReady) this.detail.drawStroke(stroke);
    this.schedule();
  }

  /** 한 획이 빠지거나 순서가 바뀐 경우: 그 영역과 겹치는 획만 순서대로 다시 그린다 */
  private redrawStrokeRegion(region: Bounds) {
    this.overview.redrawRegion(this.store.strokes, region);
    if (this.detailReady) this.detail.redrawRegion(this.store.strokes, region);
    if (this.detailBuilding) this.rebuildDetail(); // 만드는 중이던 뒷버퍼에는 이 변경이 반영되지 않았으므로 처음부터
    this.schedule();
  }

  private onViewChanged() {
    this.detailGen++; // 진행 중이던 detail 렌더링 취소(완성된 detail 은 변환해서 계속 보여준다)
    this.detailBuilding = false;
    this.liveDirty = true;
    this.remoteDirty = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.onSettled(), SETTLE_MS);
    this.schedule();
  }

  /** 이 배율에서 overview(저해상도)보다 정밀한 detail 이 필요한가 */
  private useDetail() {
    return this.dpr * this.viewport.scale > OVERVIEW_SCALE * 1.3;
  }

  /** 뷰가 멈췄을 때: 지금 detail 이 쓸만하면 그대로(평행 이동만 한 경우), 아니면 다시 만든다 */
  private onSettled() {
    if (!this.useDetail()) {
      this.detailReady = false;
      return;
    }
    if (this.detailReady && this.detailFits()) return;
    this.rebuildDetail();
  }

  /** 완성된 detail 이 현재 배율이고 화면(+10% 여유)을 덮는가 */
  private detailFits() {
    const k = this.dpr * this.viewport.scale;
    if (Math.abs(k / this.detail.k - 1) > 0.02) return false;
    const v = this.viewport.visibleRect();
    const mx = (v.x1 - v.x0) * 0.1;
    const my = (v.y1 - v.y0) * 0.1;
    const d = this.detail.logicalRect();
    return v.x0 - mx >= d.x0 && v.y0 - my >= d.y0 && v.x1 + mx <= d.x1 && v.y1 + my <= d.y1;
  }

  /**
   * 현재 배율/위치를 중심으로 detail 을 뒷버퍼에 시간을 나눠 그리고, 완성되면 교체한다.
   * 완성 전까지는 이전 detail(변환) 또는 overview 가 보이므로 깜빡이지 않는다.
   */
  private rebuildDetail() {
    clearTimeout(this.settleTimer);
    if (!this.useDetail()) return;
    const gen = ++this.detailGen;
    this.detailBuilding = true;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    const back = this.detailBack;
    // 화면 중앙이 detail 캔버스 중앙에 오도록
    const ox = d * x + (back.canvas.width - this.canvas.width) / 2;
    const oy = d * y + (back.canvas.height - this.canvas.height) / 2;
    back.setView(d * scale, ox, oy);
    back.clear();
    back.renderSliced(
      this.store.strokes,
      () => gen !== this.detailGen, // 뷰가 또 바뀌었거나 다시 시작됨
      () => {
        [this.detail, this.detailBack] = [this.detailBack, this.detail];
        this.detailReady = true;
        this.detailBuilding = false;
        this.schedule();
      },
      back.logicalRect(),
    );
  }

  private endActive() {
    this.active = null;
    this.liveDirty = false;
    this.live.clear();
    this.schedule();
  }

  // ---- 합성 ----

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    this.compose();
    this.frameListeners.forEach((cb) => cb());
  };

  private redrawLive() {
    this.liveDirty = false;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    this.live.setView(d * scale, d * x, d * y);
    this.live.clear();
    if (this.active && this.active.points.length > 1) this.live.drawStroke(this.active);
  }

  private redrawRemote() {
    this.remoteDirty = false;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    this.remoteLive.setView(d * scale, d * x, d * y);
    this.remoteLive.clear();
    for (const s of this.remoteActive.values()) {
      if (s.tool === 'pen' && s.points.length > 1) this.remoteLive.drawStroke(s);
    }
  }

  private compose() {
    const c = this.ctx;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = BACKDROP_COLOR;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 종이 (shadowBlur 는 전체 화면 해상도에서 프레임마다 그리면 비싸서 얇은 테두리로 대체)
    c.fillStyle = PAPER_BORDER;
    c.fillRect(d * x - 1, d * y - 1, d * scale * LOGICAL_W + 2, d * scale * LOGICAL_H + 2);
    c.fillStyle = PAPER_COLOR;
    c.fillRect(d * x, d * y, d * scale * LOGICAL_W, d * scale * LOGICAL_H);

    // 획: 종이 영역 밖은 잘라낸다
    c.save();
    c.beginPath();
    c.rect(d * x, d * y, d * scale * LOGICAL_W, d * scale * LOGICAL_H);
    c.clip();

    if (this.liveDirty) this.redrawLive();
    if (this.remoteDirty) this.redrawRemote();
    const active = this.active;
    if (active?.tool === 'eraser') {
      // 진행 중인 지우개: 확정된 획을 버퍼에 옮기고 live 모양만큼 지운 결과를 보여준다
      const buf = this.getScratch();
      const b = buf.getContext('2d')!;
      b.globalCompositeOperation = 'source-over';
      b.clearRect(0, 0, buf.width, buf.height);
      this.drawCommittedTo(b);
      b.globalCompositeOperation = 'destination-out';
      b.drawImage(this.live.canvas, 0, 0);
      b.globalCompositeOperation = 'source-over';
      c.drawImage(buf, 0, 0);
    } else {
      this.drawCommittedTo(c);
      if (active) c.drawImage(this.live.canvas, 0, 0);
    }
    if (this.remoteActive.size) c.drawImage(this.remoteLive.canvas, 0, 0);
    c.restore();
  }

  /**
   * 확정된 획을 t 에 그린다. 완성된 detail 이 있으면 그것을 현재 뷰로 변환해서 쓰고(덮는 영역),
   * 덮지 못하는 곳은 overview 로 채운다. detail 이 없으면 overview 만 쓴다.
   */
  private drawCommittedTo(t: CanvasRenderingContext2D) {
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    t.imageSmoothingQuality = 'high';
    const drawOverview = () =>
      t.drawImage(this.overview.canvas, d * x, d * y, d * scale * LOGICAL_W, d * scale * LOGICAL_H);

    if (!(this.useDetail() && this.detailReady)) {
      drawOverview();
      return;
    }
    // detail 픽셀 -> 현재 화면: 배율 s 만큼 늘리고 평행 이동 (줌 도중에는 s != 1 이라 잠깐 흐릿하다가 다시 그려지면 선명해진다)
    const det = this.detail;
    const s = (d * scale) / det.k;
    const dx = d * x - det.ox * s;
    const dy = d * y - det.oy * s;
    const dw = det.canvas.width * s;
    const dh = det.canvas.height * s;
    // overview 는 detail 이 덮는 사각형 바깥에만 (even-odd 로 안쪽을 제외)
    t.save();
    t.beginPath();
    t.rect(0, 0, this.canvas.width, this.canvas.height);
    t.rect(dx, dy, dw, dh);
    t.clip('evenodd');
    drawOverview();
    t.restore();
    t.drawImage(det.canvas, dx, dy, dw, dh);
  }

  private getScratch() {
    if (!this.scratch) {
      this.scratch = document.createElement('canvas');
      this.scratch.width = this.canvas.width;
      this.scratch.height = this.canvas.height;
    }
    return this.scratch;
  }
}
