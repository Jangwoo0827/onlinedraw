// database.rules.json 검증: 로컬 에뮬레이터(Auth 9099 + Realtime Database 9000)가 떠 있어야 한다.
//   npm run emulators        (터미널 1)
//   npm run test:rules       (터미널 2)
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import {
  connectDatabaseEmulator, getDatabase, ref, set, update, get, remove, serverTimestamp, increment, child,
} from 'firebase/database';

const HOST = process.env.EMULATOR_HOST ?? '127.0.0.1';
const apps = [];
let failed = 0;
let total = 0;

async function client(name, { auth = true } = {}) {
  const app = initializeApp(
    { apiKey: 'fake', projectId: 'demo-onlinedraw', databaseURL: 'https://demo-onlinedraw-default-rtdb.firebaseio.com' },
    `${name}-${Math.random().toString(36).slice(2)}`,
  );
  apps.push(app);
  const a = getAuth(app);
  connectAuthEmulator(a, `http://${HOST}:9099`, { disableWarnings: true });
  const db = getDatabase(app);
  connectDatabaseEmulator(db, HOST, 9000);
  let uid = null;
  if (auth) uid = (await signInAnonymously(a)).user.uid;
  return { db, uid, name };
}

const denied = (e) => /permission_denied|permission denied/i.test(`${e?.code} ${e?.message}`);
async function ok(label, p) {
  total++;
  try { await p; console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}  -> 거부됨: ${e?.message}`); }
}
async function no(label, p) {
  total++;
  try { await p; failed++; console.log(`FAIL  ${label}  -> 허용되어 버림`); }
  catch (e) { if (denied(e)) console.log(`PASS  ${label}`); else { failed++; console.log(`FAIL  ${label}  -> 다른 오류: ${e?.message}`); } }
}

const rid = 'room' + Math.random().toString(36).slice(2, 10);
const KEY = 'k'.repeat(8) + Math.random().toString(36).slice(2, 10);
const R = (c) => ref(c.db, `rooms/${rid}`);
const stroke = (c, over = {}) => ({ uid: c.uid, color: '#1e88e5', size: 8, tool: 'pen', createdAt: serverTimestamp(), n: 3, pts: '1,2;3,4;5,6', ...over });
const sid = () => 's' + Math.random().toString(36).slice(2, 12);
const create = (c, id, over, countDelta = 1) => update(R(c), { [`strokes/${id}`]: stroke(c, over), 'meta/count': increment(countDelta), 'meta/lastActive': serverTimestamp() });

const A = await client('A'); // 방 만든 사람(편집자)
const B = await client('B'); // 편집 키를 가진 참가자
const C = await client('C'); // 키 없이 들어온 보기 전용
const D = await client('D'); // 틀린 키
const X = await client('X', { auth: false }); // 로그인 안 한 사용자

console.log('--- 방 생성 / 편집자 등록 ---');
await no('로그인 안 한 사용자는 읽을 수 없다', get(ref(X.db, `rooms/${rid}/meta`)));
await no('로그인 안 한 사용자는 쓸 수 없다', set(ref(X.db, `rooms/${rid}/meta/count`), 0));
await no('규칙 밖 경로(루트)에는 쓸 수 없다', set(ref(A.db, 'junk'), 1));
await no('형식이 틀린 방 ID 는 만들 수 없다', set(ref(A.db, 'rooms/a/meta/count'), 0));
await ok('A: 방 생성 (secret + meta + count)', update(R(A), { 'secret/editKey': KEY, 'meta/createdAt': serverTimestamp(), 'meta/createdBy': A.uid, 'meta/count': 0, 'meta/lastActive': serverTimestamp() }));
await no('다른 사람이 이미 있는 방의 편집 키를 덮어쓸 수 없다', set(child(R(D), 'secret/editKey'), 'hijack-key-0123456789'));
await no('createdBy 를 남의 uid 로 위조할 수 없다 (새 방)', update(ref(D.db, `rooms/${rid}x/`), { 'meta/createdAt': serverTimestamp(), 'meta/createdBy': A.uid, 'meta/count': 0, 'secret/editKey': 'abcdefghijkl1' }));
await ok('A: 편집자 등록 (올바른 키)', set(child(R(A), `editors/${A.uid}`), KEY));
await ok('B: 편집자 등록 (올바른 키)', set(child(R(B), `editors/${B.uid}`), KEY));
await no('D: 틀린 키로는 편집자 등록 불가', set(child(R(D), `editors/${D.uid}`), 'wrong-key-0000000'));
await no('C: 키 없이는 편집자 등록 불가', set(child(R(C), `editors/${C.uid}`), ''));
await no('남의 uid 로 편집자 등록 불가', set(child(R(D), `editors/${A.uid}`), KEY));
await no('편집 키는 읽을 수 없다', get(child(R(B), 'secret/editKey')));
await no('편집자 목록은 읽을 수 없다', get(child(R(B), 'editors')));
await no('방 전체를 한 번에 읽을 수도 없다(secret 노출 방지)', get(R(B)));
await ok('로그인한 누구나 meta 는 읽을 수 있다', get(child(R(C), 'meta')));

console.log('--- 획 만들기 / 수정 / 삭제 ---');
const s1 = sid();
await ok('A: 획 생성 (개수 +1, 서버 타임스탬프)', create(A, s1));
await ok('C(보기 전용)도 획 목록은 읽을 수 있다', get(child(R(C), 'strokes')));
await no('C(보기 전용): 획을 만들 수 없다', create(C, sid()));
await no('D(틀린 키): 획을 만들 수 없다', create(D, sid()));
await no('B: 남의 uid 로 획을 만들 수 없다', create(B, sid(), { uid: A.uid }));
await no('B: A 의 획을 삭제할 수 없다', update(R(B), { [`strokes/${s1}`]: null, 'meta/count': increment(-1) }));
await no('B: A 의 획을 수정할 수 없다 (덮어쓰기)', create(B, s1, { color: '#ff0000' }));
await no('A: 자기 획도 수정할 수 없다 (불변)', set(child(R(A), `strokes/${s1}/color`), '#00ff00'));
await no('획 생성 시 개수를 +1 하지 않으면 거부', update(R(A), { [`strokes/${sid()}`]: stroke(A) }));
await no('개수를 +2 로 건너뛰면 거부', create(A, sid(), {}, 2));
await no('포인트 수 상한(1500) 초과 n 은 거부', create(A, sid(), { n: 1501 }));
await no('pts 문자열 길이 상한(32000) 초과는 거부', create(A, sid(), { pts: '1,1;'.repeat(8001) }));
await no('pts 에 허용되지 않는 문자가 있으면 거부', create(A, sid(), { pts: '1,2;<script>' }));
await no('색상 형식이 틀리면 거부', create(A, sid(), { color: 'red' }));
await no('굵기 상한(200) 초과는 거부', create(A, sid(), { size: 500 }));
await no('도구 값이 pen/eraser 가 아니면 거부', create(A, sid(), { tool: 'laser' }));
await no('createdAt 을 위조하면 거부 (서버 시각만 허용)', create(A, sid(), { createdAt: 1 }));
await no('정의되지 않은 필드가 있으면 거부', create(A, sid(), { evil: 'x' }));
await ok('A: 자기 획은 삭제할 수 있다 (실행 취소)', update(R(A), { [`strokes/${s1}`]: null, 'meta/count': increment(-1) }));
const s2 = sid();
await ok('A: 압력 포함 포인트 형식', create(A, s2, { pts: '1.5,2.5,0.31;3,4,0.5' }));
await ok('B: 자기 획 생성', create(B, sid()));
await ok('A: 다시 같은 id 로 재생성(다시 실행)', create(A, s1));

console.log('--- 진행 중인 획(live) ---');
const l1 = sid();
await ok('A: live 노드 생성', set(child(R(A), `live/${l1}`), { uid: A.uid, color: '#e53935', size: 6, tool: 'pen', pts: { p0000: '1,2;3,4' } }));
await ok('A: live 묶음 추가', set(child(R(A), `live/${l1}/pts/p0001`), '5,6;7,8'));
await no('B: A 의 live 에 묶음을 추가할 수 없다', set(child(R(B), `live/${l1}/pts/p0002`), '9,9'));
await no('B: A 의 live 를 지울 수 없다', remove(child(R(B), `live/${l1}`)));
await no('C(보기 전용): live 를 만들 수 없다', set(child(R(C), `live/${sid()}`), { uid: C.uid, color: '#e53935', size: 6, tool: 'pen', pts: { p0000: '1,2' } }));
await no('live 묶음 이름 형식이 틀리면 거부', set(child(R(A), `live/${l1}/pts/bad`), '1,2'));
await no('live 묶음 길이 상한(8000) 초과는 거부', set(child(R(A), `live/${l1}/pts/p0003`), '1,1;'.repeat(2001)));
await ok('A: live 를 지울 수 있다', remove(child(R(A), `live/${l1}`)));
await ok('A: 없는 live 를 지우는 것(아주 짧은 획의 확정 update)도 허용', update(R(A), { [`strokes/${sid()}`]: stroke(A, { n: 1, pts: '5,6' }), 'meta/count': increment(1), [`live/${sid()}`]: null }));

console.log('--- 전체 지우기 / 활동 시각 ---');
await ok('A(편집자): 전체 지우기 마커', update(R(A), { 'meta/clearedAt': serverTimestamp() }));
await no('C(보기 전용): 전체 지우기 불가', update(R(C), { 'meta/clearedAt': serverTimestamp() }));
await no('clearedAt 을 임의 값으로 위조하면 거부', set(child(R(A), 'meta/clearedAt'), 5));
await no('C(보기 전용): 개수(count)를 바꿀 수 없다', set(child(R(C), 'meta/count'), 0));
await no('C(보기 전용): lastActive 를 바꿀 수 없다', update(R(C), { 'meta/lastActive': serverTimestamp() }));

console.log('--- 방당 획 개수 상한(20000) ---');
await ok('A: 개수를 19999 로 (편집자)', set(child(R(A), 'meta/count'), 19999));
await ok('A: 20000 번째 획은 허용', create(A, sid()));
await no('20001 번째 획은 거부', create(A, sid()));
await ok('A: 자기 획을 지우면 다시 그릴 수 있다', update(R(A), { [`strokes/${s2}`]: null, 'meta/count': increment(-1) }));
await ok('(정리) 다시 그리기 가능', create(A, sid()));

console.log('--- 접속(presence) / 커서 ---');
await ok('C(보기 전용)도 자기 접속 표시는 가능', set(child(R(C), `presence/${C.uid}`), { name: '구경꾼', color: '#1e88e5', edit: false, t: serverTimestamp() }));
await no('남의 접속 표시를 쓸 수 없다', set(child(R(C), `presence/${A.uid}`), { name: '가짜', color: '#1e88e5', edit: true, t: serverTimestamp() }));
await no('닉네임 길이 상한(20) 초과는 거부', set(child(R(A), `presence/${A.uid}`), { name: 'x'.repeat(21), color: '#1e88e5', edit: true, t: serverTimestamp() }));
await no('빈 닉네임은 거부', set(child(R(A), `presence/${A.uid}`), { name: '', color: '#1e88e5', edit: true, t: serverTimestamp() }));
await no('닉네임만 부분 update 하면(t 검증 때문에) 거부 — 클라이언트는 통째로 다시 쓴다', update(child(R(A), `presence/${A.uid}`), { name: '새이름' }));
await ok('A: 닉네임 변경 (통째로 다시 쓰기)', set(child(R(A), `presence/${A.uid}`), { name: '새이름', color: '#1e88e5', edit: true, t: serverTimestamp() }));
await ok('내 커서 위치 기록', set(child(R(C), `cursors/${C.uid}`), { x: 8000, y: 8000 }));
await no('캔버스 밖 커서 좌표는 거부', set(child(R(C), `cursors/${C.uid}`), { x: 99999, y: 0 }));
await no('남의 커서를 쓸 수 없다', set(child(R(C), `cursors/${A.uid}`), { x: 1, y: 1 }));
await ok('접속 목록은 로그인한 누구나 읽을 수 있다', get(child(R(C), 'presence')));

console.log('--- 정리 ---');
await no('방에 정의되지 않은 키는 만들 수 없다', set(child(R(A), 'junk'), 1));

await Promise.all(apps.map((a) => deleteApp(a)));
console.log(failed ? `\n${failed}/${total} FAILED` : `\nALL ${total} PASSED`);
process.exit(failed ? 1 : 0);
