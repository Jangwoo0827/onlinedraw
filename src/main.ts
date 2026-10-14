import './style.css';
import { CanvasInput } from './canvas/input';
import { Renderer } from './canvas/renderer';
import { StrokeStore } from './canvas/store';
import { ToolState } from './canvas/tool-state';
import { Viewport } from './canvas/viewport';
import { createFirebase, signInAnon } from './firebase/client';
import { RoomSync } from './sync/room-sync';
import { resolveRoomId } from './sync/room';
import { mountToolbar } from './ui/toolbar';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;

const viewport = new Viewport();
const store = new StrokeStore();
const tools = new ToolState();
const renderer = new Renderer(canvas, viewport, store);
const input = new CanvasInput(canvas, viewport, tools, store, renderer);

const { setStatus } = mountToolbar(document.getElementById('topbar')!, document.getElementById('panel')!, {
  tools,
  store,
  viewport,
});

// 리사이즈 / 화면 회전 / devicePixelRatio 변화 대응
const resize = () => {
  const { width, height } = stage.getBoundingClientRect();
  renderer.resize(width, height, window.devicePixelRatio || 1);
};
new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 100));
window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', resize);
resize();

// 방 동기화. Firebase 설정이 없으면 혼자 그리는 로컬 모드로 계속 동작한다.
let sync: RoomSync | null = null;
async function connect() {
  let fb: ReturnType<typeof createFirebase>;
  try {
    fb = createFirebase();
  } catch (e) {
    console.error('[firebase]', e);
    setStatus({ state: 'error', pending: 0, message: 'Firebase 설정이 올바르지 않습니다 (.env 확인)' });
    return;
  }
  if (!fb) {
    setStatus({ state: 'local', pending: 0 });
    return;
  }
  setStatus({ state: 'connecting', pending: 0 });
  const { roomId } = resolveRoomId(); // 링크가 바로 공유되도록 인증 전에 URL 에 반영
  let uid: string;
  try {
    uid = await signInAnon(fb.auth);
  } catch (e) {
    console.error('[auth]', e);
    setStatus({ state: 'error', pending: 0, message: '로그인 실패 (익명 로그인 설정을 확인하세요)' });
    return;
  }
  const adopted = store.adoptUid(uid); // 로그인 전에 그린 획은 내 것으로 바꿔 함께 올린다
  sync = new RoomSync(fb.db, roomId, uid, store, renderer, setStatus);
  input.hooks = {
    start: (s) => sync!.localStart(s),
    extend: (s) => sync!.localExtend(s),
    finish: (s) => sync!.localFinish(s),
    cancel: (s) => sync!.localCancel(s),
  };
  sync.start();
  sync.pushStrokes(adopted);
  if (import.meta.env.DEV) (window as unknown as { __draw: Record<string, unknown> }).__draw.sync = sync;
}
void connect();

// 단축키
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type !== 'range') return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    store.redo();
  } else if (!mod && key === 'p') {
    tools.setTool('pen');
  } else if (!mod && key === 'e') {
    tools.setTool('eraser');
  } else if (!mod && key === '0') {
    viewport.fit();
  }
});

// 개발 중 콘솔/자동 테스트용 디버그 핸들
if (import.meta.env.DEV) {
  (window as unknown as { __draw: unknown }).__draw = { viewport, store, tools, renderer, input };
}
