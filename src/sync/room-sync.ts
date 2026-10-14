import {
  child,
  get,
  goOffline,
  goOnline,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  orderByChild,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type Database,
  type DatabaseReference,
  type Unsubscribe,
} from 'firebase/database';
import type { Renderer } from '../canvas/renderer';
import type { StrokeStore } from '../canvas/store';
import type { Stroke } from '../canvas/types';
import { setServerOffset } from './clock';
import { decodePoints, encodePoints, parseStroke } from './codec';

/** 진행 중인 획의 포인트를 묶어서 보내는 간격 */
const FLUSH_MS = 50;

export type SyncState = 'connecting' | 'online' | 'offline' | 'error';
export interface SyncStatus {
  state: SyncState;
  /** 서버 확인을 아직 받지 못한 확정 획 수 (끊긴 동안 그린 획 포함) */
  pending: number;
  message?: string;
}

interface LocalProgress {
  sent: number; // 이미 보낸 점 개수
  seq: number; // 다음 묶음 번호
  timer: number;
  created: boolean; // live 노드를 만들었는가
}

/**
 * 방 하나와의 실시간 동기화.
 *
 *  rooms/{room}/meta                : 생성 시각, 만든 사람
 *  rooms/{room}/strokes/{id}        : 확정된 획 { uid, color, size, tool, createdAt(서버 시각), n, pts }
 *  rooms/{room}/live/{id}           : 진행 중인 획 { uid, color, size, tool, pts: { p0000: "x,y;...", p0001: ... } }
 *
 * 내 획은 로컬에서 먼저 그리고, 그리는 중에는 포인트 묶음을 live 에 올리고, 끝나면 단순화한 최종 획을
 * strokes 에 쓰면서 live 를 지운다(한 번의 원자적 update). 순서는 createdAt(서버 타임스탬프)으로 통일한다.
 */
export class RoomSync {
  private roomRef: DatabaseReference;
  private local = new Map<string, LocalProgress>();
  private remote = new Map<string, { stroke: Stroke; unsub: Unsubscribe }>();
  private unsubs: Unsubscribe[] = [];
  private status: SyncStatus = { state: 'connecting', pending: 0 };

  constructor(
    private db: Database,
    readonly roomId: string,
    private uid: string,
    private store: StrokeStore,
    private renderer: Renderer,
    private onStatus: (s: SyncStatus) => void,
  ) {
    this.roomRef = ref(db, `rooms/${roomId}`);
  }

  start() {
    this.emit({});
    this.unsubs.push(
      onValue(ref(this.db, '.info/connected'), (snap) => {
        this.emit({ state: snap.val() === true ? 'online' : 'offline', message: undefined });
      }),
      onValue(ref(this.db, '.info/serverTimeOffset'), (snap) => {
        const v = snap.val();
        if (typeof v === 'number') setServerOffset(v);
      }),
    );
    void this.ensureMeta();

    // 확정된 획: 서버 타임스탬프 순으로 받는다. 입장 시 기존 획 전체가 먼저 오고, 이후 실시간으로 이어진다.
    const strokes = query(child(this.roomRef, 'strokes'), orderByChild('createdAt'));
    const apply = (snap: { key: string | null; val(): unknown }) => {
      if (!snap.key) return;
      const v = snap.val() as { pts?: unknown } | null;
      const stroke = parseStroke(snap.key, v, decodePoints(v?.pts));
      if (stroke) this.store.upsert(stroke);
    };
    this.unsubs.push(
      onChildAdded(strokes, apply),
      onChildChanged(strokes, apply),
      onChildRemoved(strokes, (snap) => snap.key && this.store.removeById(snap.key)),
    );

    // 다른 참가자의 진행 중인 획
    const live = child(this.roomRef, 'live');
    this.unsubs.push(
      onChildAdded(live, (snap) => this.remoteStart(snap.key, snap.val())),
      onChildRemoved(live, (snap) => snap.key && this.remoteEnd(snap.key)),
    );

    // 스토어의 실행 취소/다시 실행을 서버에 반영
    this.store.onChange((event, stroke) => {
      if (stroke.uid !== this.uid) return;
      if (event === 'undo') this.track(remove(child(this.roomRef, `strokes/${stroke.id}`)));
      else if (event === 'redo') this.track(set(child(this.roomRef, `strokes/${stroke.id}`), this.strokeData(stroke)));
    });
  }

  /** 인증 전에 그려 둔 획 등 아직 서버에 없는 내 획을 올린다 */
  pushStrokes(strokes: Stroke[]) {
    for (const s of strokes) this.track(set(child(this.roomRef, `strokes/${s.id}`), this.strokeData(s)));
  }

  stop() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const { unsub, stroke } of this.remote.values()) {
      unsub();
      this.renderer.endRemote(stroke.id);
    }
    this.remote.clear();
  }

  /** 연결 끊김/복귀 시뮬레이션 (개발·테스트용). 끊긴 동안의 쓰기는 SDK 가 큐에 쌓았다가 복귀 후 전송한다. */
  setNetwork(online: boolean) {
    if (online) goOnline(this.db);
    else goOffline(this.db);
  }

  // ---------- 내 획 -> 서버 (StrokeHooks 구현) ----------

  localStart(stroke: Stroke) {
    this.local.set(stroke.id, { sent: 0, seq: 0, timer: 0, created: false });
  }

  localExtend(stroke: Stroke) {
    const st = this.local.get(stroke.id);
    if (!st || st.timer) return;
    st.timer = window.setTimeout(() => {
      st.timer = 0;
      this.flush(stroke, st);
    }, FLUSH_MS);
  }

  localFinish(stroke: Stroke) {
    const st = this.local.get(stroke.id);
    if (st) {
      clearTimeout(st.timer);
      this.local.delete(stroke.id);
    }
    // 최종 획 기록 + live 제거를 한 번에: 다른 참가자는 진행 중 표시가 사라지는 순간 확정된 획을 받는다
    this.track(
      update(this.roomRef, {
        [`strokes/${stroke.id}`]: this.strokeData(stroke),
        [`live/${stroke.id}`]: null,
      }),
    );
    if (st?.created) void onDisconnect(child(this.roomRef, `live/${stroke.id}`)).cancel();
  }

  localCancel(stroke: Stroke) {
    const st = this.local.get(stroke.id);
    if (!st) return;
    clearTimeout(st.timer);
    this.local.delete(stroke.id);
    if (st.created) {
      const node = child(this.roomRef, `live/${stroke.id}`);
      this.track(remove(node));
      void onDisconnect(node).cancel();
    }
  }

  // ---------- 내부 ----------

  private flush(stroke: Stroke, st: LocalProgress) {
    if (!this.local.has(stroke.id) || stroke.points.length <= st.sent) return;
    const chunk = encodePoints(stroke.points.slice(st.sent));
    st.sent = stroke.points.length;
    const key = `p${String(st.seq++).padStart(4, '0')}`;
    const node = child(this.roomRef, `live/${stroke.id}`);
    if (!st.created) {
      st.created = true;
      // 끊기면(앱 종료/네트워크 단절) 서버가 진행 중 표시를 치워 준다
      void onDisconnect(node).remove();
      this.track(
        set(node, { uid: stroke.uid, color: stroke.color, size: stroke.size, tool: stroke.tool, pts: { [key]: chunk } }),
        false,
      );
    } else {
      this.track(set(child(node, `pts/${key}`), chunk), false);
    }
  }

  private strokeData(s: Stroke) {
    return {
      uid: s.uid,
      color: s.color,
      size: s.size,
      tool: s.tool,
      createdAt: serverTimestamp(),
      n: s.points.length,
      pts: encodePoints(s.points),
    };
  }

  private remoteStart(id: string | null, v: unknown) {
    if (!id || this.remote.has(id)) return;
    const stroke = parseStroke(id, v, []);
    if (!stroke || stroke.uid === this.uid) return; // 내 획의 메아리는 무시
    // 헤더만 받고, 포인트 묶음은 도착하는 대로 이어서 받는다(이미 올라온 묶음도 여기서 순서대로 온다)
    const unsub = onChildAdded(child(this.roomRef, `live/${id}/pts`), (snap) => {
      const points = decodePoints(snap.val());
      if (!points.length) return;
      const prevLen = stroke.points.length;
      for (const p of points) stroke.points.push(p);
      this.renderer.remoteExtended(stroke, prevLen);
    });
    this.remote.set(id, { stroke, unsub });
    this.renderer.beginRemote(stroke);
  }

  private remoteEnd(id: string) {
    const entry = this.remote.get(id);
    if (!entry) return;
    entry.unsub();
    this.remote.delete(id);
    this.renderer.endRemote(id);
  }

  private async ensureMeta() {
    try {
      const metaRef = child(this.roomRef, 'meta');
      const snap = await get(metaRef);
      if (!snap.exists()) await set(metaRef, { createdAt: serverTimestamp(), createdBy: this.uid });
    } catch (e) {
      this.fail(e);
    }
  }

  /** 서버 확인(ack) 대기 중인 확정 획 수를 센다. count=false 는 진행 중 묶음 등 세지 않는 쓰기. */
  private track(op: Promise<unknown>, count = true) {
    if (count) this.emit({ pending: this.status.pending + 1 });
    op.then(
      () => count && this.emit({ pending: this.status.pending - 1 }),
      (e) => {
        if (count) this.emit({ pending: this.status.pending - 1 });
        this.fail(e);
      },
    );
  }

  private fail(e: unknown) {
    const code = (e as { code?: string })?.code ?? '';
    const message = code.includes('PERMISSION_DENIED') ? '쓰기 권한이 없습니다' : '동기화 오류';
    console.error('[sync]', e);
    this.emit({ state: 'error', message });
  }

  private emit(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }
}
