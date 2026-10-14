import { COLORS, MAX_SIZE, MIN_SIZE } from '../canvas/constants';
import type { StrokeStore } from '../canvas/store';
import type { ToolState } from '../canvas/tool-state';
import type { Viewport } from '../canvas/viewport';
import { icons } from './icons';

interface Deps {
  tools: ToolState;
  store: StrokeStore;
  viewport: Viewport;
}

function button(label: string, html: string, className = 'btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = html;
  return b;
}

export function mountToolbar(top: HTMLElement, panel: HTMLElement, { tools, store, viewport }: Deps) {
  // ---- 상단: 제목 + 실행 취소/다시 실행/전체 보기 ----
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = '같이 그리기';
  const undoBtn = button('실행 취소 (Ctrl+Z)', icons.undo);
  const redoBtn = button('다시 실행 (Ctrl+Shift+Z)', icons.redo);
  const fitBtn = button('전체 보기', icons.fit);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(undoBtn, redoBtn, fitBtn);
  top.append(title, actions);

  undoBtn.addEventListener('click', () => store.undo());
  redoBtn.addEventListener('click', () => store.redo());
  fitBtn.addEventListener('click', () => viewport.fit());

  // ---- 하단: 도구 + 굵기 + 색상 ----
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
  panel.append(row1, swatches);

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
  const syncHistory = () => {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  };

  tools.onChange(syncTools);
  store.onChange(syncHistory);
  viewport.onChange(syncPreview);
  syncTools();
  syncHistory();
}
