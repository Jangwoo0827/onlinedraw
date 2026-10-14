import './style.css';
import { union, strokeBounds, type Bounds } from './canvas/bounds';
import { exportPng, downloadBlob } from './canvas/export';
import { CanvasInput } from './canvas/input';
import { Renderer } from './canvas/renderer';
import { StrokeStore } from './canvas/store';
import { ToolState } from './canvas/tool-state';
import { Viewport } from './canvas/viewport';
import { createFirebase, signInAnon } from './firebase/client';
import { loadProfile, Presence, type Participant } from './sync/presence';
import { resolveRoom, roomLinks, type RoomInfo } from './sync/room';
import { RoomSync, type SyncStatus } from './sync/room-sync';
import { copyText } from './ui/clipboard';
import { CursorLayer } from './ui/cursors';
import { mountMinimap } from './ui/minimap';
import { mountMenu, mountParticipants } from './ui/panels';
import { showToast } from './ui/toast';
import { mountToolbar, type ConnectionView } from './ui/toolbar';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;

const viewport = new Viewport();
const store = new StrokeStore();
const tools = new ToolState();
const renderer = new Renderer(canvas, viewport, store);
const input = new CanvasInput(canvas, viewport, tools, store, renderer);
const cursors = new CursorLayer(stage, viewport);
mountMinimap(stage, renderer, viewport);

const ui = mountToolbar(document.getElementById('topbar')!, document.getElementById('panel')!, { tools, store, viewport });

// 리사이즈 / 화면 회전 / devicePixelRatio 변화 대응
const resize = () => {
  const { width, height } = stage.getBoundingClientRect();
  renderer.resize(width, height, window.devicePixelRatio || 1);
};
new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 100));
window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', resize);
resize();

// ---------- 방 / 동기화 (Firebase 설정이 없으면 혼자 그리는 로컬 모드) ----------
let sync: RoomSync | null = null;
let presence: Presence | null = null;
let room: RoomInfo | null = null;
const LOCAL: ConnectionView = { state: 'local', pending: 0, access: 'editor', full: false, badKey: false };

const participants = mountParticipants(ui.peopleBtn, {
  getMyName: () => presence?.me.name ?? '',
  onRename: (name) => presence?.setName(name),
  onFocus: (p) => p.cursor && viewport.centerOn(p.cursor.x, p.cursor.y),
});
const menu = mountMenu(ui.menuBtn, {
  copyEditLink: () => void copyLink('edit'),
  copyViewLink: () => void copyLink('view'),
  savePng: () => void savePng(),
  clearAll: () => clearAll(),
});

async function copyLink(kind: 'edit' | 'view') {
  if (!room) return;
  const links = roomLinks(room);
  const url = kind === 'edit' ? links.edit : links.view;
  if (!url) return;
  const ok = await copyText(url);
  showToast(ok ? (kind === 'edit' ? '편집 링크를 복사했어요' : '보기 전용 링크를 복사했어요') : '복사하지 못했어요. 주소창의 링크를 직접 복사해 주세요');
}

async function savePng() {
  const blob = await exportPng(store.strokes);
  if (!blob) {
    showToast('아직 그린 내용이 없어요');
    return;
  }
  downloadBlob(blob, `onlinedraw-${room?.roomId ?? 'local'}.png`);
  showToast('PNG 를 저장했어요');
}

function clearAll() {
  if (!window.confirm('모든 참가자의 그림이 지워지고 되돌릴 수 없어요.\n정말 전체 지우기를 할까요?')) return;
  if (sync) sync.clearAll();
  else {
    store.clearRedo();
    store.removeWhere(() => true);
  }
  showToast('전체를 지웠어요');
}

/** 그릴 수 있는 상태를 입력/UI 에 반영 */
function applyAccess(s: ConnectionView) {
  const viewer = s.access === 'viewer';
  const editable = !viewer && !s.full;
  input.drawEnabled = editable;
  const message = viewer
    ? s.badKey
      ? '편집 링크가 올바르지 않아 보기 전용으로 열었어요. 이동/확대만 할 수 있어요'
      : '보기 전용이에요. 이동/확대만 할 수 있어요'
    : s.full
      ? '이 방은 획 개수 한도에 도달해서 더 그릴 수 없어요'
      : '';
  ui.setEditable(editable, message);
  menu.setEditable(!viewer);
}

let lastAccess = '';
function onSyncStatus(s: SyncStatus) {
  ui.setStatus(s);
  applyAccess(s);
  if (s.access !== lastAccess) {
    if (lastAccess === 'pending' && s.access === 'viewer' && s.badKey) showToast('편집 링크가 올바르지 않아요');
    lastAccess = s.access;
    presence?.announce(); // 편집/보기 전용 구분이 확정되면 접속 표시를 갱신
  }
}

function onPeople(list: Participant[]) {
  participants.render(list);
  cursors.update(list);
  ui.setPeopleCount(list.length);
}

/** 처음 불러오기가 끝났을 때: 직접 움직이지 않았다면 그림이 있는 곳으로 이동 */
function onLoaded() {
  if (viewport.moved || !store.strokes.length) return;
  let b: Bounds | null = null;
  for (const s of store.strokes) b = union(b, strokeBounds(s));
  if (b) viewport.focusRect(b, 1);
}

async function connect() {
  let fb: ReturnType<typeof createFirebase>;
  try {
    fb = createFirebase();
  } catch (e) {
    console.error('[firebase]', e);
    ui.setStatus({ ...LOCAL, state: 'error', message: 'Firebase 설정이 올바르지 않습니다 (.env 확인)' });
    return;
  }
  if (!fb) {
    ui.setStatus(LOCAL);
    menu.setEditable(true);
    return;
  }
  ui.setStatus({ ...LOCAL, state: 'connecting' });
  room = resolveRoom(); // 링크가 바로 공유되도록 인증 전에 URL 에 반영
  if (!room.editKey) applyAccess({ ...LOCAL, access: 'viewer' }); // 보기 전용 링크: 처음부터 그릴 수 없음
  let uid: string;
  try {
    uid = await signInAnon(fb.auth);
  } catch (e) {
    console.error('[auth]', e);
    ui.setStatus({ ...LOCAL, state: 'error', message: '로그인 실패 (익명 로그인 설정을 확인하세요)' });
    return;
  }
  const adopted = store.adoptUid(uid); // 로그인 전에 그린 획은 내 것으로 바꿔 함께 올린다
  sync = new RoomSync(fb.db, room.roomId, uid, room.editKey, store, renderer, onSyncStatus, onLoaded);
  presence = new Presence(fb.db, room.roomId, uid, loadProfile(), () => sync?.canEdit ?? false, onPeople);
  input.hooks = {
    start: (s) => sync!.localStart(s),
    extend: (s) => sync!.localExtend(s),
    finish: (s) => sync!.localFinish(s),
    cancel: (s) => sync!.localCancel(s),
  };
  input.onCursor = (x, y) => presence?.sendCursor(x, y);
  input.onCursorLeave = () => presence?.clearCursor();
  sync.start();
  for (const s of adopted) sync.localFinish(s);
  ui.setPeopleCount(1);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __draw: object }).__draw, { sync, presence, room });
}
void connect();

// PWA: 홈 화면에 추가한 앱이 오프라인에서도 열리도록 서비스 워커 등록 (배포 빌드에서만)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => console.warn('[sw]', e));
  });
}

// 단축키
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type !== 'range') return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (!input.drawEnabled) return;
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    if (input.drawEnabled) store.redo();
  } else if (!mod && key === 'p') {
    tools.setTool('pen');
  } else if (!mod && key === 'e') {
    tools.setTool('eraser');
  } else if (!mod && key === '0') {
    viewport.fitAll();
  }
});

// 개발 중 콘솔/자동 테스트용 디버그 핸들
if (import.meta.env.DEV) {
  (window as unknown as { __draw: unknown }).__draw = { viewport, store, tools, renderer, input };
}
