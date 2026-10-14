import { COLORS, MAX_SIZE, MIN_SIZE } from '../canvas/constants';
import type { StrokeStore } from '../canvas/store';
import type { ToolState } from '../canvas/tool-state';
import type { Viewport } from '../canvas/viewport';
import type { Access, SyncState } from '../sync/room-sync';
import { icons } from './icons';

interface Deps {
  tools: ToolState;
  store: StrokeStore;
  viewport: Viewport;
}

/** 상단 상태 표시에 필요한 정보. 로컬 모드(Firebase 없음)는 state 가 'local'. */
export interface ConnectionView {
  state: SyncState | 'local';
  access: Access;
  pending: number;
  full: boolean;
  badKey: boolean;
  message?: string;
}

export function button(label: string, html: string, className = 'btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = html;
  return b;
}

export function mountToolbar(top: HTMLElement, panel: HTMLElement, { tools, store, viewport }: Deps) {
  // ---- 상단: 제목/상태 + 참가자/실행 취소/다시 실행/전체 보기/메뉴 ----
  const title = document.createElement('div');
  title.className = 'title';
  const name = document.createElement('div');
  name.textContent = '같이 그리기';
  const status = document.createElement('div');
  status.className = 'status';
  const statusDot = document.createElement('i');
  const statusText = document.createElement('span');
  status.append(statusDot, statusText);
  title.append(name, status);

  const peopleBtn = button('참가자', icons.users, 'btn people');
  const peopleCount = document.createElement('b');
  peopleBtn.append(peopleCount);
  peopleBtn.hidden = true;
  const undoBtn = button('실행 취소 (Ctrl+Z)', icons.undo);
  const redoBtn = button('다시 실행 (Ctrl+Shift+Z)', icons.redo);
  const fitBtn = button('캔버스 전체 보기 (0)', icons.fit);
  const menuBtn = button('메뉴', icons.more);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(peopleBtn, undoBtn, redoBtn, fitBtn, menuBtn);
  top.append(title, actions);

  undoBtn.addEventListener('click', () => store.undo());
  redoBtn.addEventListener('click', () => store.redo());
  fitBtn.addEventListener('click', () => viewport.fitAll());

  // ---- 하단: 도구 + 굵기 + 색상 (보기 전용이면 안내 문구) ----
  const penBtn = button('펜', icons.pen, 'btn tool');
  const eraserBtn = button('지우개', icons.eraser, 'btn tool');
  penBtn.addEventListener('click', () => tools.setTool('pen'));
  eraserBtn.addEventListener('click', () => tools.setTool('eraser'));

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(MIN_SIZE);
  slider.max = String(MAX_SIZE);
  slider.step = '1';
  slider.setAttribute('aria-label', '굵기');
  slider.addEventListener('input', () => tools.setSize(Number(slider.value)));

  const preview = document.createElement('div');
  preview.className = 'preview';
  const dot = document.createElement('i');
  preview.append(dot);
  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'size-label';

  const row1 = document.createElement('div');
  row1.className = 'row';
  row1.append(penBtn, eraserBtn, slider, preview, sizeLabel);

  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  const swatchBtns = COLORS.map((color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.setProperty('--c', color);
    b.setAttribute('aria-label', `색상 ${color}`);
    b.addEventListener('click', () => tools.setColor(color));
    swatches.append(b);
    return { b, color };
  });
  const banner = document.createElement('div');
  banner.className = 'banner';
  panel.append(row1, swatches, banner);

  // ---- 상태 반영 ----
  const syncTools = () => {
    penBtn.setAttribute('aria-pressed', String(tools.tool === 'pen'));
    eraserBtn.setAttribute('aria-pressed', String(tools.tool === 'eraser'));
    slider.value = String(tools.size);
    sizeLabel.textContent = String(tools.size);
    for (const { b, color } of swatchBtns) {
      b.setAttribute('aria-pressed', String(tools.tool === 'pen' && tools.color === color));
    }
    panel.classList.toggle('erasing', tools.tool === 'eraser');
    syncPreview();
  };
  // 미리보기 점은 실제 화면에서 보이는 굵기(논리 굵기 x 현재 확대율)를 반영, 단 칸 안에 들어가도록 제한
  const syncPreview = () => {
    const px = Math.min(34, Math.max(2, tools.size * viewport.scale));
    dot.style.width = dot.style.height = `${px}px`;
    dot.style.background = tools.tool === 'eraser' ? 'transparent' : tools.color;
    dot.style.border = tools.tool === 'eraser' ? '1.5px dashed #888' : 'none';
  };
  let editable = true;
  const syncHistory = () => {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  };

  tools.onChange(syncTools);
  store.onChange(syncHistory);
  viewport.onChange(syncPreview);
  syncTools();
  syncHistory();

  // ---- 연결 상태 표시 ----
  const LABEL: Record<ConnectionView['state'], string> = {
    local: '로컬 모드 (Firebase 미설정)',
    connecting: '연결 중…',
    online: '연결됨',
    offline: '재연결 중…',
    error: '오류',
  };

  return {
    peopleBtn,
    menuBtn,
    setStatus(s: ConnectionView) {
      status.dataset.state = s.state;
      let text = s.state === 'error' && s.message ? s.message : LABEL[s.state];
      if (s.access === 'viewer') text += ' · 보기 전용';
      if (s.pending > 0 && s.state !== 'local') text += ` · 전송 대기 ${s.pending}`;
      statusText.textContent = text;
    },
    /** null 이면 참가자 버튼을 숨긴다 (로컬 모드) */
    setPeopleCount(n: number | null) {
      peopleBtn.hidden = n === null;
      peopleCount.textContent = n === null ? '' : String(n);
    },
    /** 그릴 수 없는 상태(보기 전용, 획 한도)면 도구 대신 안내 문구를 보여준다 */
    setEditable(value: boolean, message = '') {
      editable = value;
      panel.classList.toggle('readonly', !value);
      banner.textContent = message;
      undoBtn.hidden = redoBtn.hidden = !value;
      if (value) syncHistory();
    },
    get editable() {
      return editable;
    },
  };
}
