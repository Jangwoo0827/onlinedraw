import {
  child,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  type Database,
  type DatabaseReference,
  type Unsubscribe,
} from 'firebase/database';
import { USER_COLORS } from '../canvas/constants';

/** 커서 위치 전송 간격 */
const CURSOR_MS = 100;

export interface Profile {
  name: string;
  color: string;
}

export interface Participant extends Profile {
  uid: string;
  /** 그릴 수 있는 참가자인가 (false 면 보기 전용) */
  edit: boolean;
  self: boolean;
  /** 마지막으로 받은 커서 위치(논리 좌표)와 수신 시각 */
  cursor: { x: number; y: number; at: number } | null;
}

const ADJECTIVES = ['행복한', '졸린', '용감한', '수줍은', '빠른', '느긋한', '반짝이는', '엉뚱한', '다정한', '씩씩한'];
const ANIMALS = ['고양이', '강아지', '토끼', '여우', '펭귄', '판다', '수달', '고래', '다람쥐', '오리'];

/** 이 브라우저에서 쓰던 닉네임/색을 불러오거나 처음이면 임시로 만든다. */
export function loadProfile(): Profile {
  let name = '';
  let color = '';
  try {
    name = localStorage.getItem('od.name') ?? '';
    color = localStorage.getItem('od.color') ?? '';
  } catch {
    /* 저장소를 못 쓰는 환경(시크릿 모드 등)은 매번 새로 만든다 */
  }
  const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
  if (!name) name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = pick(USER_COLORS);
  saveProfile({ name, color });
  return { name, color };
}

function saveProfile(p: Profile) {
  try {
    localStorage.setItem('od.name', p.name);
    localStorage.setItem('od.color', p.color);
  } catch {
    /* ignore */
  }
}

export const sanitizeName = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, 20);

/**
 * 접속 중인 사람과 커서.
 *  rooms/{room}/presence/{uid} : { name, color, edit, t }   — 접속 중에만 존재 (onDisconnect 로 제거)
 *  rooms/{room}/cursors/{uid}  : { x, y }                   — 약 100ms 단위로 갱신
 */
export class Presence {
  private presenceRef: DatabaseReference;
  private cursorRef: DatabaseReference;
  private people = new Map<string, Participant>();
  private unsubs: Unsubscribe[] = [];
  private cursorTimer = 0;
  private pendingCursor: { x: number; y: number } | null = null;
  private lastSent = '';
  private lastSentAt = 0;

  constructor(
    db: Database,
    roomId: string,
    private uid: string,
    private profile: Profile,
    private getEdit: () => boolean,
    private onChange: (list: Participant[]) => void,
  ) {
    const room = ref(db, `rooms/${roomId}`);
    this.presenceRef = child(room, `presence/${uid}`);
    this.cursorRef = child(room, `cursors/${uid}`);
    const presence = child(room, 'presence');
    const cursors = child(room, 'cursors');

    this.unsubs.push(
      // 연결될 때마다(처음, 재연결) 내 접속 표시를 다시 올리고 끊김 시 제거되도록 예약한다
      onValue(ref(db, '.info/connected'), (snap) => {
        if (snap.val() === true) this.announce();
      }),
      onValue(presence, (snap) => {
        const next = new Map<string, Participant>();
        snap.forEach((c) => {
          const v = c.val() as { name?: unknown; color?: unknown; edit?: unknown } | null;
          if (!c.key || !v || typeof v.name !== 'string') return;
          const prev = this.people.get(c.key);
          next.set(c.key, {
            uid: c.key,
            name: sanitizeName(v.name) || '익명',
            color: typeof v.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.color) ? v.color : '#888888',
            edit: v.edit === true,
            self: c.key === this.uid,
            cursor: prev?.cursor ?? null,
          });
        });
        this.people = next;
        this.emit();
      }),
    );
    const setCursor = (snap: { key: string | null; val(): unknown }) => {
      const v = snap.val() as { x?: unknown; y?: unknown } | null;
      const p = snap.key ? this.people.get(snap.key) : undefined;
      if (!p || !v || typeof v.x !== 'number' || typeof v.y !== 'number') return;
      p.cursor = { x: v.x, y: v.y, at: Date.now() };
      this.emit();
    };
    this.unsubs.push(
      onChildAdded(cursors, setCursor),
      onChildChanged(cursors, setCursor),
      onChildRemoved(cursors, (snap) => {
        const p = snap.key ? this.people.get(snap.key) : undefined;
        if (p) {
          p.cursor = null;
          this.emit();
        }
      }),
    );
  }

  /** 내 접속 표시 올리기. 편집 권한이 확정되면(edit 값이 바뀌면) 다시 호출한다. */
  announce() {
    void onDisconnect(this.presenceRef).remove();
    void onDisconnect(this.cursorRef).remove();
    void set(this.presenceRef, {
      name: this.profile.name,
      color: this.profile.color,
      edit: this.getEdit(),
      t: serverTimestamp(),
    }).catch((e) => console.error('[presence]', e));
  }

  setName(raw: string) {
    const name = sanitizeName(raw);
    if (!name || name === this.profile.name) return;
    this.profile = { ...this.profile, name };
    saveProfile(this.profile);
    // 규칙이 t(접속 시각)를 항상 현재 서버 시각으로 검증하므로 일부만 update 하지 않고 통째로 다시 쓴다
    this.announce();
  }

  get me(): Profile {
    return this.profile;
  }

  /** 내 커서/손가락 위치(논리 좌표). 약 100ms 에 한 번으로 줄여서 보낸다. */
  sendCursor(x: number, y: number) {
    this.pendingCursor = { x: Math.round(x), y: Math.round(y) };
    if (this.cursorTimer) return;
    const wait = Math.max(0, CURSOR_MS - (Date.now() - this.lastSentAt));
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = 0;
      const c = this.pendingCursor;
      this.pendingCursor = null;
      if (!c) return;
      const key = `${c.x},${c.y}`;
      if (key === this.lastSent) return;
      this.lastSent = key;
      this.lastSentAt = Date.now();
      void set(this.cursorRef, c).catch(() => {});
    }, wait);
  }

  /** 커서가 캔버스를 벗어났을 때 */
  clearCursor() {
    clearTimeout(this.cursorTimer);
    this.cursorTimer = 0;
    this.pendingCursor = null;
    this.lastSent = '';
    void remove(this.cursorRef).catch(() => {});
  }

  stop() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    void remove(this.presenceRef).catch(() => {});
    void remove(this.cursorRef).catch(() => {});
  }

  private emit() {
    this.onChange([...this.people.values()]);
  }
}
