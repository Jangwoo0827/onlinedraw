export type Tool = 'pen' | 'eraser';

/** [x, y, pressure?] — 캔버스 논리 좌표. pressure(0..1)는 필압이 있는 입력에서만 존재. */
export type Point = [x: number, y: number, pressure?: number];

export interface Stroke {
  id: string;
  uid: string;
  color: string;
  size: number;
  tool: Tool;
  points: Point[];
  createdAt: number;
}
