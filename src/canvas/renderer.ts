import { BACKDROP_COLOR, LOGICAL_H, LOGICAL_W, PAPER_BORDER, PAPER_COLOR } from './constants';
import { StrokeCache } from './stroke-cache';
import type { StrokeStore } from './store';
import type { Stroke } from './types';
import type { Viewport } from './viewport';

/** base 캐시의 해상도(논리 1 당 픽셀). 이동/핀치 중에 늘려 그려도 덜 흐리도록 화면 맞춤 배율보다 넉넉하게. */
const BASE_SCALE = 1.5;
/** 뷰 변화가 멈춘 뒤 detail 을 다시 그리기까지의 대기 시간 */
const SETTLE_MS = 120;

/**
 * 레이어 구성 (확정된 획은 한 번 그려 캐싱해 두고, 프레임마다는 합성만 한다)
 *
 *  base   : 확정된 획. 논리 좌표 고정 해상도(BASE_SCALE). 뷰와 무관하므로 이동/줌 중에는 이걸 변환해서 보여준다.
 *  detail : 확정된 획. 현재 뷰 해상도로 정확히 그린 것. 뷰가 멈추면 시간을 쪼개 다시 만들고, 완성되면 base 대신 쓴다.
 *  live   : 지금 그리고 있는 내 획 하나(증분). 지우개 획은 모양만 담고 합성 때 아래 레이어를 지운다.
 *  remote : 다른 참가자가 지금 그리고 있는 획들(증분, 펜만). 획이 확정되면 store 로 옮겨가 base/detail 에 그려진다.
 *
 * 확정된 획이 늘어날 때는 base/detail 에 그 획만 덧그리고(증분), 실행 취소처럼 되돌릴 때만 전체 다시 그리기를 한다.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private base = this.newBase();
  private detail = new StrokeCache();
  private live = new StrokeCache(true);
  private remoteLive = new StrokeCache();
  private remoteActive = new Map<string, Stroke>();
  private remoteDirty = false;
  private scratch: HTMLCanvasElement | null = null; // 지우개 획이 진행 중일 때만 쓰는 합성용 버퍼

  private active: Stroke | null = null;
  private liveDirty = false;
  private detailValid = false;
  private detailGen = 0; // 진행 중인 detail 렌더링을 취소하기 위한 세대 번호
  private baseGen = 0; // 진행 중인 base 전체 다시 그리기를 취소하기 위한 세대 번호
  private baseBusy = false;
  private raf = 0;
  private settleTimer = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private store: StrokeStore,
  ) {
    this.ctx = canvas.getContext('2d')!;

    viewport.onChange(() => this.onViewChanged());
    store.onChange((event, stroke) => {
      if (event === 'add' || event === 'redo') this.drawCommitted(stroke); // 끝에 추가: 그 획만 덧그린다
      else this.renderAll(); // undo / remove / reorder: 중간이 바뀌었으므로 전체
    });
  }

  /** cssW/cssH: CSS px 크기 */
  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(dpr, 3);
    const w = cssW * this.dpr;
    const h = cssH * this.dpr;
    this.canvas.width = Math.max(1, Math.round(w));
    this.canvas.height = Math.max(1, Math.round(h));
    this.detail.resize(w, h);
    this.live.resize(w, h);
    this.remoteLive.resize(w, h);
    this.scratch = null;
    this.viewport.setSize(cssW, cssH);
    this.onViewChanged();
  }

  /** base/detail 이 모두 최신이고 시간을 나눠 진행 중인 작업이 없는가 (테스트/디버그용) */
  get settled() {
    return this.detailValid && !this.baseBusy;
  }

  /**
   * 전체 다시 그리기: 확정된 획 전체로 base 를 새로 만들고(백버퍼에 시간을 나눠 그린 뒤 교체),
   * 이어서 detail 도 다시 만든다. (실행 취소 등) 획이 적으면 같은 틱에서 바로 끝난다.
   */
  renderAll() {
    this.detailGen++;
    this.detailValid = false; // 되돌린 획이 남아 보이지 않도록 낡은 detail 은 즉시 버린다
    const gen = ++this.baseGen;
    this.baseBusy = true;
    const next = this.newBase();
    next.renderSliced(
      this.store.strokes,
      () => gen !== this.baseGen,
      () => {
        this.base = next;
        this.baseBusy = false;
        this.rebuildDetail();
        this.schedule();
      },
    );
  }

  private newBase() {
    const cache = new StrokeCache();
    cache.resize(LOGICAL_W * BASE_SCALE, LOGICAL_H * BASE_SCALE);
    cache.setView(BASE_SCALE, 0, 0);
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

  /** 획 종료: live 를 비운다. 확정된 획은 store.add 의 'add' 이벤트에서 base/detail 에 그려진다. */
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
    this.base.drawStroke(stroke);
    // detail 이 아직 만들어지는 중이면 store.strokes 를 순회하는 쪽이 이 획도 그려준다
    if (this.detailValid) this.detail.drawStroke(stroke);
    this.schedule();
  }

  private onViewChanged() {
    this.detailGen++; // 진행 중이던 detail 렌더링 취소
    this.detailValid = false;
    this.liveDirty = true;
    this.remoteDirty = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.rebuildDetail(), SETTLE_MS);
    this.schedule();
  }

  /** 현재 뷰 해상도로 확정된 획을 다시 그린다. 프레임당 일정 분량씩 나눠서 진행(획이 많아도 입력/화면이 끊기지 않게). */
  private rebuildDetail() {
    clearTimeout(this.settleTimer);
    const gen = ++this.detailGen;
    this.detailValid = false;
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    this.detail.setView(d * scale, d * x, d * y);
    this.detail.clear();

    this.detail.renderSliced(
      this.store.strokes,
      () => gen !== this.detailGen, // 뷰가 또 바뀌었거나 다시 시작됨
      () => {
        this.detailValid = true;
        this.schedule();
      },
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

  /** detail 이 완성돼 있으면 그대로, 아니면 base 를 현재 뷰로 변환해서 그린다. */
  private drawCommittedTo(t: CanvasRenderingContext2D) {
    if (this.detailValid) {
      t.drawImage(this.detail.canvas, 0, 0);
      return;
    }
    const { scale, x, y } = this.viewport;
    const d = this.dpr;
    t.imageSmoothingQuality = 'high';
    t.drawImage(this.base.canvas, d * x, d * y, d * scale * LOGICAL_W, d * scale * LOGICAL_H);
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
