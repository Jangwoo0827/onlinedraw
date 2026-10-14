import {
  child,
  get,
  goOffline,
  goOnline,
  increment,
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
import { ROOM_STROKE_LIMIT } from '../canvas/constants';
import type { Renderer } from '../canvas/renderer';
import type { StrokeStore } from '../canvas/store';
import type { Stroke } from '../canvas/types';
import { setServerOffset } from './clock';
import { decodePoints, encodePoints, parseStroke } from './codec';

/** 진행 중인 획의 포인트를 묶어서 보내는 간격 */
const FLUSH_MS = 50;

export type SyncState = 'connecting' | 'online' | 'offline' | 'error';
/** pending: 입장 확인 전 / editor: 그릴 수 있음 / viewer: 보기 전용 */
export type Access = 'pending' | 'editor' | 'viewer';
export interface SyncStatus {
  state: SyncState;
  access: Access;
  /** 서버 확인을 아직 받지 못한 확정 획 수 (끊긴 동안 그린 획 포함) */
  pending: number;
  /** 방이 획 개수 상한에 도달해 더 그릴 수 없음 */
  full: boolean;
  /** 편집 키가 있었는데 서버가 거부함 (잘못된 링크) */
  badKey: boolean;
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
 *  rooms/{room}/meta                : { createdAt, createdBy, count(확정 획 수), lastActive, clearedAt }
 *  rooms/{room}/secret/editKey      : 편집 키 (읽기 불가, 한 번만 기록). 규칙이 이 값과 비교한다.
 *  rooms/{room}/editors/{uid}       : 편집 키를 제시해 편집자로 등록된 사용자 (읽기 불가)
 *  rooms/{room}/strokes/{id}        : 확정된 획 { uid, color, size, tool, createdAt(서버 시각), n, pts }
 *  rooms/{room}/live/{id}           : 진행 중인 획 { uid, color, size, tool, pts: { p0000: "x,y;...", ... } }
 *
 * 내 획은 로컬에서 먼저 그리고, 그리는 중에는 포인트 묶음을 live 에 올리고, 끝나면 단순화한 최종 획을
 * strokes 에 쓰면서 live 를 지운다(한 번의 원자적 update). 순서는 createdAt(서버 타임스탬프)으로 통일한다.
 */
export class RoomSync {
  private roomRef: DatabaseReference;
  private local = new Map<string, LocalProgress>();
  private remote = new Map<string, { stroke: Stroke; unsub: Unsubscribe }>();
  private unsubs: Unsubscribe[] = [];
  private status: SyncStatus = { state: 'connecting', access: 'pending', pending: 0, full: false, badKey: false };
  private joining = false;
  /** 입장 확인 전에 끝난 내 획 (편집자로 확인되면 올리고, 보기 전용이면 버린다) */
  private queued: Stroke[] = [];
  private clearedAt = 0;
  private count = 0;
  /** 편집자로 확인되기 전에 정리 대상이 된 내 획 id (확인되면 서버에서 지운다) */
  private gcQueue: string[] = [];

  constructor(
    private db: Database,
    readonly roomId: string,
    private uid: string,
    private editKey: string | null,
    private store: StrokeStore,
    private renderer: Renderer,
    private onStatus: (s: SyncStatus) => void,
    /** 처음 불러오기가 끝났을 때 (입장 시 기존 획 전체 수신 완료) */
    private onLoaded: () => void = () => {},
  ) {
    this.roomRef = ref(db, `rooms/${roomId}`);
  }

  get canEdit() {
    return this.status.access === 'editor';
  }

  start() {
    this.emit({});
    this.unsubs.push(
      onValue(ref(this.db, '.info/connected'), (snap) => {
        const online = snap.val() === true;
        this.emit({ state: online ? 'online' : 'offline', message: undefined });
        if (online) void this.join();
      }),
      onValue(ref(this.db, '.info/serverTimeOffset'), (snap) => {
        const v = snap.val();
        if (typeof v === 'number') setServerOffset(v);
      }),
    );

    // 확정된 획: 서버 타임스탬프 순으로 받는다. 입장 시 기존 획 전체가 먼저 오고, 이후 실시간으로 이어진다.
    const strokes = query(child(this.roomRef, 'strokes'), orderByChild('createdAt'));
    const apply = (snap: { key: string | null; val(): unknown }) => {
      if (!snap.key) return;
      const v = snap.val() as { pts?: unknown } | null;
      const stroke = parseStroke(snap.key, v, decodePoints(v?.pts));
      if (!stroke) return;
      if (stroke.createdAt <= this.clearedAt) {
        // 전체 지우기 이전의 획: 보이지 않게 하고, 내 것이면 서버에서도 정리한다
        if (stroke.uid === this.uid) this.collectGarbage([stroke.id]);
        return;
      }
      this.store.upsert(stroke);
    };
    this.unsubs.push(
      onChildAdded(strokes, apply),
      onChildChanged(strokes, apply),
      onChildRemoved(strokes, (snap) => snap.key && this.store.removeById(snap.key)),
      // 초기 데이터 수신이 끝나면 한 번 호출된다 (child_added 가 모두 먼저 발생)
      onValue(strokes, () => this.onLoaded(), { onlyOnce: true }),
    );

    // 다른 참가자의 진행 중인 획
    const live = child(this.roomRef, 'live');
    this.unsubs.push(
      onChildAdded(live, (snap) => this.remoteStart(snap.key, snap.val())),
      onChildRemoved(live, (snap) => snap.key && this.remoteEnd(snap.key)),
    );

    // 전체 지우기 마커, 획 개수
    this.unsubs.push(
      onValue(child(this.roomRef, 'meta/clearedAt'), (snap) => {
        const t = snap.val();
        if (typeof t === 'number' && t > this.clearedAt) this.applyClear(t);
      }),
      onValue(child(this.roomRef, 'meta/count'), (snap) => {
        const n = snap.val();
        this.count = typeof n === 'number' ? n : 0;
        this.emit({ full: this.count >= ROOM_STROKE_LIMIT });
      }),
    );

    // 스토어의 실행 취소/다시 실행을 서버에 반영 (내 획만)
    this.store.onChange((event, stroke) => {
      if (!stroke || stroke.uid !== this.uid || !this.canEdit) return;
      if (event === 'undo') {
        this.track(update(this.roomRef, { [`strokes/${stroke.id}`]: null, 'meta/count': increment(-1) }));
      } else if (event === 'redo') {
        this.track(update(this.roomRef, this.createPaths(stroke)));
      }
    });
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

  /** 전체 지우기: 마커만 남긴다. 각 참가자가 자기 획을 정리(규칙상 남의 획은 못 지움). */
  clearAll() {
    if (!this.canEdit) return;
    this.store.clearRedo();
    this.track(update(this.roomRef, { 'meta/clearedAt': serverTimestamp(), 'meta/lastActive': serverTimestamp() }));
  }

  // ---------- 입장 (방 생성 / 편집자 등록) ----------

  /** 연결될 때마다 성공할 때까지 시도한다. 방이 없으면 편집 키로 만들고, 편집 키로 편집자 등록을 한다. */
  private async join() {
    if (this.joining || this.status.access !== 'pending') return;
    this.joining = true;
    try {
      const metaRef = child(this.roomRef, 'meta');
      let exists = (await get(metaRef)).exists();
      if (!exists && this.editKey) {
        try {
          await update(this.roomRef, {
            'secret/editKey': this.editKey,
            'meta/createdAt': serverTimestamp(),
            'meta/createdBy': this.uid,
            'meta/count': 0,
            'meta/lastActive': serverTimestamp(),
          });
          exists = true;
        } catch {
          // 그 사이 다른 사람이 같은 방을 만들었다면 아래 등록 절차로 이어간다
        }
      }
      if (!this.editKey) {
        this.becomeViewer(false);
        return;
      }
      try {
        await set(child(this.roomRef, `editors/${this.uid}`), this.editKey);
        this.becomeEditor();
      } catch (e) {
        if (isPermissionDenied(e)) this.becomeViewer(true);
        else throw e;
      }
    } catch (e) {
      this.fail(e); // 네트워크 문제 등: 다음 연결 때 다시 시도
    } finally {
      this.joining = false;
    }
  }

  private becomeEditor() {
    this.emit({ access: 'editor', badKey: false });
    const queued = this.queued.splice(0);
    for (const s of queued) this.track(update(this.roomRef, this.createPaths(s)));
    if (this.gcQueue.length) this.collectGarbage(this.gcQueue.splice(0));
  }

  private becomeViewer(badKey: boolean) {
    this.emit({ access: 'viewer', badKey });
    // 편집자 확인 전에 그린 획은 보내지 못한다
    for (const s of this.queued.splice(0)) this.store.removeById(s.id);
  }

  // ---------- 내 획 -> 서버 (StrokeHooks 구현) ----------

  localStart(stroke: Stroke) {
    this.local.set(stroke.id, { sent: 0, seq: 0, timer: 0, created: false });
  }

  localExtend(stroke: Stroke) {
    const st = this.local.get(stroke.id);
    if (!st || st.timer || !this.canEdit) return;
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
    if (!this.canEdit) {
      if (this.status.access === 'pending') this.queued.push(stroke);
      return;
    }
    // 최종 획 기록 + live 제거 + 개수/활동 시각 갱신을 한 번에: 다른 참가자는 진행 중 표시가 사라지는 순간 확정된 획을 받는다.
    // 아주 짧은 획(탭)은 live 노드를 만들기 전에 끝나므로, 만든 경우에만 지운다.
    const paths: Record<string, unknown> = this.createPaths(stroke);
    if (st?.created) paths[`live/${stroke.id}`] = null;
    this.track(update(this.roomRef, paths));
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

  /** 확정 획 하나를 만드는 쓰기 경로들 (획, 개수, 마지막 활동 시각) */
  private createPaths(s: Stroke) {
    return {
      [`strokes/${s.id}`]: this.strokeData(s),
      'meta/count': increment(1),
      'meta/lastActive': serverTimestamp(),
    };
  }

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

  /** 전체 지우기 마커 적용: 그 시각 이전 획을 모두 숨기고, 내 획은 서버에서도 정리한다. */
  private applyClear(t: number) {
    this.clearedAt = t;
    this.store.clearRedo();
    const removed = this.store.removeWhere((s) => s.createdAt <= t);
    const mine = removed.filter((s) => s.uid === this.uid).map((s) => s.id);
    if (mine.length) this.collectGarbage(mine);
  }

  /** 내 획을 서버에서 삭제 (규칙상 자기 획만 삭제 가능). 한 번에 너무 많이 보내지 않도록 나눈다. */
  private collectGarbage(ids: string[]) {
    if (!this.canEdit) {
      if (this.status.access === 'pending') this.gcQueue.push(...ids);
      return;
    }
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const paths: Record<string, unknown> = { 'meta/count': increment(-batch.length) };
      for (const id of batch) paths[`strokes/${id}`] = null;
      this.track(update(this.roomRef, paths), false);
    }
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
    const message = isPermissionDenied(e) ? '쓰기 권한이 없습니다' : '동기화 오류';
    console.error('[sync]', e);
    this.emit({ state: 'error', message });
  }

  private emit(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }
}

function isPermissionDenied(e: unknown) {
  return ((e as { code?: string })?.code ?? '').includes('PERMISSION_DENIED') || /permission_denied/i.test(String((e as Error)?.message));
}
