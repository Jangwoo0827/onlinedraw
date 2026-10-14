import { drawSegment, drawStroke } from './stroke-draw';
import type { Stroke } from './types';

/** 시간 분할 렌더링의 프레임당 예산. 캔버스는 그리기 명령을 모았다가 나중에 래스터화하므로 시간만으로는 부정확해 점 개수도 함께 제한한다. */
const SLICE_MS = 8;
const SLICE_POINTS = 2000;

/**
 * 획이 그려지는 오프스크린 캔버스 하나. 논리 좌표 -> 캔버스 픽셀은 균일 배율 + 이동으로 변환한다.
 *   pixel = logical * k + (ox, oy)
 * 전체 다시 그리기(renderAll)와 증분 그리기(drawStroke / drawSegmentsFrom)를 분리해서 제공한다.
 */
export class StrokeCache {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;

  /** solidEraser: 지우개 획을 지우지 않고 불투명 검정으로 그린다(진행 중 획의 모양 레이어) */
  constructor(private solidEraser = false) {}

  /** 크기를 바꾸면 내용과 변환이 초기화되므로 이후 setView 를 다시 호출해야 한다. */
  resize(width: number, height: number) {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
  }

  setView(k: number, ox: number, oy: number) {
    this.ctx.setTransform(k, 0, 0, k, ox, oy);
  }

  clear() {
    const c = this.ctx;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.restore();
  }

  /** 증분: 획 하나를 통째로 얹는다 (확정된 획 추가, redo) */
  drawStroke(stroke: Stroke) {
    drawStroke(this.ctx, stroke, this.solidEraser);
  }

  /** 증분: 점이 prevLen 이후로 추가된 만큼의 새 구간만 그린다 (진행 중인 획) */
  drawSegmentsFrom(stroke: Stroke, prevLen: number) {
    for (let k = Math.max(1, prevLen); k < stroke.points.length; k++) {
      drawSegment(this.ctx, stroke, k - 1, this.solidEraser);
    }
  }

  /** 전체: 비우고 모든 획을 순서대로 다시 그린다 */
  renderAll(strokes: readonly Stroke[]) {
    this.clear();
    for (const s of strokes) this.drawStroke(s);
  }

  /**
   * renderAll 과 같은 결과를 프레임당 일정 분량씩 나눠서 그린다(비우지는 않는다). 획이 적으면 같은 틱에서 끝난다.
   * isStale() 이 true 가 되면 중단하고, 끝까지 그리면 onDone() 을 호출한다.
   * 진행 중에 strokes 배열에 획이 추가되면 그것도 이어서 그린다.
   */
  renderSliced(strokes: readonly Stroke[], isStale: () => boolean, onDone: () => void) {
    let i = 0;
    const step = () => {
      if (isStale()) return;
      const t0 = performance.now();
      let budget = SLICE_POINTS;
      while (i < strokes.length && budget > 0) {
        const s = strokes[i++];
        this.drawStroke(s);
        budget -= s.points.length;
        if (performance.now() - t0 > SLICE_MS) break;
      }
      if (i < strokes.length) requestAnimationFrame(step);
      else onDone();
    };
    step();
  }
}
