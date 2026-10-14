import type { Participant } from '../sync/presence';
import type { Viewport } from '../canvas/viewport';

/** 이 시간 동안 움직임이 없으면 다른 사람의 커서를 숨긴다 */
const IDLE_MS = 5000;

/** 다른 참가자의 커서/손가락 위치를 캔버스 위에 이름표와 함께 표시한다. */
export class CursorLayer {
  private el = document.createElement('div');
  private nodes = new Map<string, HTMLDivElement>();
  private people: Participant[] = [];
  private raf = 0;

  constructor(
    stage: HTMLElement,
    private viewport: Viewport,
  ) {
    this.el.id = 'cursors';
    stage.append(this.el);
    viewport.onChange(() => this.schedule());
    window.setInterval(() => this.schedule(), 1000); // 오래 가만히 있는 커서를 숨기기 위한 주기 갱신
  }

  update(people: Participant[]) {
    this.people = people;
    this.schedule();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.render()));
  }

  private render() {
    const { scale, x, y, width, height } = this.viewport;
    const now = Date.now();
    const seen = new Set<string>();
    for (const p of this.people) {
      if (p.self || !p.cursor) continue;
      const sx = p.cursor.x * scale + x;
      const sy = p.cursor.y * scale + y;
      const visible = now - p.cursor.at < IDLE_MS && sx > -24 && sy > -24 && sx < width + 24 && sy < height + 24;
      let node = this.nodes.get(p.uid);
      if (!node) {
        node = document.createElement('div');
        node.className = 'cursor';
        node.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
        this.el.append(node);
        this.nodes.set(p.uid, node);
      }
      seen.add(p.uid);
      node.style.color = p.color;
      node.firstElementChild!.nextElementSibling!.textContent = p.name;
      node.style.transform = `translate(${sx}px, ${sy}px)`;
      node.style.opacity = visible ? '1' : '0';
    }
    for (const [uid, node] of this.nodes) {
      if (!seen.has(uid)) {
        node.remove();
        this.nodes.delete(uid);
      }
    }
  }
}
