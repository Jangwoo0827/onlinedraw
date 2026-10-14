import './style.css';
import { CanvasInput } from './canvas/input';
import { Renderer } from './canvas/renderer';
import { StrokeStore } from './canvas/store';
import { ToolState } from './canvas/tool-state';
import { Viewport } from './canvas/viewport';
import { mountToolbar } from './ui/toolbar';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;

const viewport = new Viewport();
const store = new StrokeStore();
const tools = new ToolState();
const renderer = new Renderer(canvas, viewport, store);
new CanvasInput(canvas, viewport, tools, store, renderer, 'local'); // uid 는 STEP 3에서 Firebase 익명 uid 로 교체

mountToolbar(document.getElementById('topbar')!, document.getElementById('panel')!, { tools, store, viewport });

// 리사이즈 / 화면 회전 / devicePixelRatio 변화 대응
const resize = () => {
  const { width, height } = stage.getBoundingClientRect();
  renderer.resize(width, height, window.devicePixelRatio || 1);
};
new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 100));
window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', resize);
resize();

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
  (window as unknown as { __draw: unknown }).__draw = { viewport, store, tools, renderer };
}
