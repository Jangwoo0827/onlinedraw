const ROOM_RE = /^[A-Za-z0-9_-]{6,40}$/;

export function newRoomId(): string {
  // crypto.getRandomValues 는 http(비보안 컨텍스트)에서도 쓸 수 있다
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 헷갈리는 문자(l, o, 0, 1) 제외
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

/** URL 의 ?room= 값을 읽고, 없거나 형식이 틀리면 새로 만들어 URL 에 반영한다. */
export function resolveRoomId(): { roomId: string; created: boolean } {
  const url = new URL(location.href);
  const current = url.searchParams.get('room');
  if (current && ROOM_RE.test(current)) return { roomId: current, created: false };
  const roomId = newRoomId();
  url.searchParams.set('room', roomId);
  history.replaceState(null, '', url);
  return { roomId, created: true };
}
