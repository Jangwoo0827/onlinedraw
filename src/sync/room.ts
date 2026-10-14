const ROOM_RE = /^[A-Za-z0-9_-]{6,40}$/;
const KEY_RE = /^[A-Za-z0-9_-]{12,40}$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 헷갈리는 문자(l, o, 0, 1) 제외

function randomString(len: number, alphabet = ALPHABET): string {
  // crypto.getRandomValues 는 http(비보안 컨텍스트)에서도 쓸 수 있다
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export interface RoomInfo {
  roomId: string;
  /** 편집 키. 있으면 그릴 수 있고, 없으면 보기 전용 링크로 들어온 것 */
  editKey: string | null;
  /** 이번에 새로 만든 방인가 (URL 에 방이 없었음) */
  created: boolean;
}

/**
 * URL 의 ?room=(방) 과 &k=(편집 키)를 읽는다. 방이 없으면 새로 만들어 URL 에 반영한다.
 *  - 편집 링크: ?room=xxxx&k=yyyy   (그릴 수 있음)
 *  - 보기 전용 링크: ?room=xxxx      (키가 없어서 서버 규칙상 쓸 수 없음)
 */
export function resolveRoom(): RoomInfo {
  const url = new URL(location.href);
  const room = url.searchParams.get('room');
  const key = url.searchParams.get('k');
  if (room && ROOM_RE.test(room)) {
    return { roomId: room, editKey: key && KEY_RE.test(key) ? key : null, created: false };
  }
  const roomId = randomString(8);
  const editKey = randomString(20, ALPHABET + 'ABCDEFGHJKLMNPQRSTUVWXYZ');
  url.searchParams.set('room', roomId);
  url.searchParams.set('k', editKey);
  history.replaceState(null, '', url);
  return { roomId, editKey, created: true };
}

/** 공유용 링크. 현재 주소의 쿼리를 정리해서 만든다. */
export function roomLinks(info: Pick<RoomInfo, 'roomId' | 'editKey'>) {
  const base = `${location.origin}${location.pathname}`;
  const view = `${base}?room=${info.roomId}`;
  return { edit: info.editKey ? `${view}&k=${info.editKey}` : null, view };
}
