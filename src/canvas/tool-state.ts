import { COLORS } from './constants';
import type { Tool } from './types';

type Listener = () => void;

/** 현재 선택된 도구/색/굵기. 도구별로 굵기를 따로 기억한다. */
export class ToolState {
  tool: Tool = 'pen';
  color: string = COLORS[0];
  private sizes: Record<Tool, number> = { pen: 8, eraser: 40 };
  private listeners = new Set<Listener>();

  get size(): number {
    return this.sizes[this.tool];
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.emit();
  }

  setColor(color: string) {
    this.color = color;
    this.tool = 'pen'; // 지우개 상태에서 색을 고르면 펜으로 복귀
    this.emit();
  }

  setSize(size: number) {
    this.sizes[this.tool] = size;
    this.emit();
  }

  onChange(cb: Listener) {
    this.listeners.add(cb);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }
}
