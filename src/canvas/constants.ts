/**
 * 고정 논리 캔버스 크기. 모든 좌표는 이 기준이라 기기 화면 크기와 무관하다.
 * r/place 처럼 아주 큰 판: 보이는 부분만 그리고(타일링 없이 영역 컬링), 전체는 저해상도 개요(overview)로 유지한다.
 */
export const LOGICAL_W = 16000;
export const LOGICAL_H = 16000;

/** 획 하나의 포인트 수 상한. 넘으면 입력 단계에서 자동으로 이어서 새 획으로 나눈다. (database.rules.json 과 맞춰야 함) */
export const MAX_POINTS_PER_STROKE = 1500;
/** 방당 확정 획 개수 상한. (database.rules.json 과 맞춰야 함) */
export const ROOM_STROKE_LIMIT = 20000;

/** 참가자 표시 색상 (커서/목록) */
export const USER_COLORS = [
  '#e53935', '#d81b60', '#8e24aa', '#5e35b1', '#3949ab', '#1e88e5',
  '#00897b', '#43a047', '#7cb342', '#f9a825', '#fb8c00', '#6d4c41',
] as const;

export const COLORS = [
  '#1a1a1a', // 검정
  '#8d8d93', // 회색
  '#e53935', // 빨강
  '#fb8c00', // 주황
  '#fdd835', // 노랑
  '#43a047', // 초록
  '#1e88e5', // 파랑
  '#8e24aa', // 보라
  '#ec407a', // 분홍
  '#6d4c41', // 갈색
] as const;

export const MIN_SIZE = 1;
export const MAX_SIZE = 120;

export const PAPER_COLOR = '#ffffff';
export const PAPER_BORDER = '#cfd1d8';
export const BACKDROP_COLOR = '#e6e7ec';
