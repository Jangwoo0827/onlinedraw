import type { Participant } from '../sync/presence';
import { icons } from './icons';

/** 상단 바 아래에 뜨는 작은 패널(팝오버). 바깥을 누르면 닫힌다. */
function createPopover(anchor: HTMLElement, id: string) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'popover';
  el.hidden = true;
  document.body.append(el);
  const close = () => {
    el.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
  };
  anchor.setAttribute('aria-haspopup', 'true');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = el.hidden;
    document.querySelectorAll<HTMLElement>('.popover').forEach((p) => (p.hidden = true));
    el.hidden = !open;
    anchor.setAttribute('aria-expanded', String(open));
  });
  // 캡처 단계에서 처리: 패널이 열린 채 캔버스를 누르면 패널만 닫고, 그 터치로 획이 그려지지는 않게 한다
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (el.hidden || el.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      close();
      if (e.target instanceof HTMLCanvasElement) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  el.addEventListener('click', (e) => e.stopPropagation());
  return { el, close };
}

export interface MenuActions {
  copyEditLink: (() => void) | null;
  copyViewLink: (() => void) | null;
  savePng: () => void;
  clearAll: () => void;
}

/** ⋮ 메뉴: 링크 복사, PNG 저장, 전체 지우기 */
export function mountMenu(anchor: HTMLElement, actions: MenuActions) {
  const { el, close } = createPopover(anchor, 'menu');
  el.setAttribute('role', 'menu');
  const item = (label: string, icon: string, onClick: () => void, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${icon}<span></span>`;
    b.lastElementChild!.textContent = label;
    b.addEventListener('click', () => {
      close();
      onClick();
    });
    el.append(b);
    return b;
  };
  const items: Record<string, HTMLButtonElement> = {};
  if (actions.copyEditLink) items.edit = item('편집 링크 복사 (같이 그리기)', icons.link, actions.copyEditLink);
  if (actions.copyViewLink) items.view = item('보기 전용 링크 복사', icons.eye, actions.copyViewLink);
  items.png = item('PNG 로 저장', icons.download, actions.savePng);
  items.clear = item('전체 지우기…', icons.trash, actions.clearAll, true);
  return {
    /** 그릴 수 없으면 전체 지우기를 숨긴다 */
    setEditable(editable: boolean) {
      items.clear.hidden = !editable;
      if (items.edit) items.edit.hidden = !editable;
    },
  };
}

/** 참가자 패널: 접속 중인 사람, 내 닉네임 수정, 누르면 그 사람 위치로 이동 */
export function mountParticipants(
  anchor: HTMLElement,
  opts: { onRename: (name: string) => void; onFocus: (p: Participant) => void; getMyName: () => string },
) {
  const { el } = createPopover(anchor, 'participants');
  const head = document.createElement('div');
  head.className = 'pop-head';
  const label = document.createElement('label');
  label.className = 'name-edit';
  label.innerHTML = '<span>내 닉네임</span>';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 20;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '내 닉네임');
  label.append(input);
  const commit = () => opts.onRename(input.value);
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
  });
  const list = document.createElement('ul');
  list.className = 'people';
  head.append(label);
  el.append(head, list);

  return {
    render(people: Participant[]) {
      if (document.activeElement !== input) input.value = opts.getMyName();
      list.replaceChildren();
      const sorted = [...people].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
      for (const p of sorted) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.disabled = p.self || !p.cursor;
        const dot = document.createElement('i');
        dot.style.background = p.color;
        const nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = p.name + (p.self ? ' (나)' : '');
        b.append(dot, nm);
        if (!p.edit) {
          const tag = document.createElement('em');
          tag.textContent = '보기 전용';
          b.append(tag);
        }
        if (!p.self) b.title = p.cursor ? '눌러서 이 사람 위치로 이동' : '아직 움직임이 없어요';
        b.addEventListener('click', () => opts.onFocus(p));
        li.append(b);
        list.append(li);
      }
    },
  };
}

