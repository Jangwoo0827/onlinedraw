import type { Stroke } from './types';

export type StoreEvent = 'add' | 'undo' | 'redo';
type Listener = (event: StoreEvent, stroke: Stroke) => void;

/** 확정된 획 목록 + 실행 취소/다시 실행 스택. */
export class StrokeStore {
  readonly strokes: Stroke[] = [];
  private redoStack: Stroke[] = [];
  private listeners = new Set<Listener>();

  get canUndo() {
    return this.strokes.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  add(stroke: Stroke) {
    this.strokes.push(stroke);
    this.redoStack.length = 0; // 새로 그리면 다시 실행 기록은 버린다
    this.emit('add', stroke);
  }

  undo(): boolean {
    const stroke = this.strokes.pop();
    if (!stroke) return false;
    this.redoStack.push(stroke);
    this.emit('undo', stroke);
    return true;
  }

  redo(): boolean {
    const stroke = this.redoStack.pop();
    if (!stroke) return false;
    this.strokes.push(stroke);
    this.emit('redo', stroke);
    return true;
  }

  onChange(cb: Listener) {
    this.listeners.add(cb);
  }

  private emit(event: StoreEvent, stroke: Stroke) {
    this.listeners.forEach((cb) => cb(event, stroke));
  }
}
