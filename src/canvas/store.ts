import type { Stroke } from './types';

/**
 * add / redo : 맨 끝에 한 획이 추가됨 (증분으로 그리면 된다)
 * undo / remove / reorder : 중간이 바뀜 -> 그 획의 영역만 다시 그리면 된다
 * reset : 여러 획이 한꺼번에 바뀜(전체 지우기) -> 전체 다시 그리기
 * history : 화면은 그대로, 실행 취소/다시 실행 가능 여부만 바뀜
 */
export type StoreEvent = 'add' | 'redo' | 'undo' | 'remove' | 'reorder' | 'reset' | 'history';
type Listener = (event: StoreEvent, stroke: Stroke | null) => void;

/** 서버 타임스탬프 순, 같으면 id 순 — 모든 참가자에게 같은 순서를 보장한다. */
export const compareStrokes = (a: Stroke, b: Stroke) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 확정된 획 목록 + 내 획 기준 실행 취소/다시 실행 스택. */
export class StrokeStore {
  readonly strokes: Stroke[] = [];
  /** 내 uid. 실행 취소는 내 획만 대상으로 한다. Firebase 인증 전에는 'local'. */
  uid = 'local';
  private byId = new Map<string, Stroke>();
  private redoStack: Stroke[] = [];
  private listeners = new Set<Listener>();

  get canUndo() {
    for (let i = this.strokes.length - 1; i >= 0; i--) if (this.strokes[i].uid === this.uid) return true;
    return false;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  has(id: string) {
    return this.byId.has(id);
  }

  /** 로컬에서 방금 그린 획을 끝에 추가 */
  add(stroke: Stroke) {
    this.strokes.push(stroke);
    this.byId.set(stroke.id, stroke);
    this.redoStack.length = 0; // 새로 그리면 다시 실행 기록은 버린다
    this.emit('add', stroke);
  }

  /** 서버에서 받은 획을 반영(멱등). 이미 있으면 createdAt 만 맞추고, 순서가 바뀌면 reorder. */
  upsert(incoming: Stroke) {
    const existing = this.byId.get(incoming.id);
    if (existing) {
      if (existing.createdAt === incoming.createdAt) return;
      const before = this.strokes.indexOf(existing);
      this.strokes.splice(before, 1);
      existing.createdAt = incoming.createdAt;
      const after = this.insertIndex(existing);
      this.strokes.splice(after, 0, existing);
      if (after !== before) this.emit('reorder', existing);
      return;
    }
    const at = this.insertIndex(incoming);
    this.strokes.splice(at, 0, incoming);
    this.byId.set(incoming.id, incoming);
    this.emit(at === this.strokes.length - 1 ? 'add' : 'reorder', incoming);
  }

  /** 서버에서 삭제됨 */
  removeById(id: string) {
    const stroke = this.byId.get(id);
    if (!stroke) return;
    this.strokes.splice(this.strokes.indexOf(stroke), 1);
    this.byId.delete(id);
    this.emit('remove', stroke);
  }

  /** 내 마지막 획을 취소. 다른 사람의 획은 건드리지 않는다. */
  undo(): boolean {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i];
      if (stroke.uid !== this.uid) continue;
      this.strokes.splice(i, 1);
      this.byId.delete(stroke.id);
      this.redoStack.push(stroke);
      this.emit('undo', stroke);
      return true;
    }
    return false;
  }

  redo(): boolean {
    const stroke = this.redoStack.pop();
    if (!stroke) return false;
    this.strokes.push(stroke);
    this.byId.set(stroke.id, stroke);
    this.emit('redo', stroke);
    return true;
  }

  /** 조건에 맞는 획을 모두 지운다(전체 지우기). 지운 획들을 돌려준다. */
  removeWhere(pred: (s: Stroke) => boolean): Stroke[] {
    const removed = this.strokes.filter(pred);
    if (!removed.length) return removed;
    const keep = this.strokes.filter((s) => !pred(s));
    this.strokes.length = 0;
    this.strokes.push(...keep);
    for (const s of removed) this.byId.delete(s.id);
    this.emit('reset', removed[0]);
    return removed;
  }

  clearRedo() {
    this.redoStack.length = 0;
    this.emit('history', null);
  }

  /** 인증 후 내 uid 가 정해지면, 그 전에 그린 'local' 획을 내 것으로 바꾼다. 바뀐 획을 돌려준다. */
  adoptUid(uid: string): Stroke[] {
    this.uid = uid;
    const adopted = this.strokes.filter((s) => s.uid === 'local');
    for (const s of adopted) s.uid = uid;
    return adopted;
  }

  onChange(cb: Listener) {
    this.listeners.add(cb);
  }

  /** compareStrokes 기준으로 들어갈 위치(같은 키 뒤쪽) */
  private insertIndex(stroke: Stroke): number {
    let lo = 0;
    let hi = this.strokes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareStrokes(this.strokes[mid], stroke) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private emit(event: StoreEvent, stroke: Stroke | null) {
    this.listeners.forEach((cb) => cb(event, stroke));
  }
}
