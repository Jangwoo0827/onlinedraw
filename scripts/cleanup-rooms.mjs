// 오래된 방 정리 (Cloud Functions 없이): 마지막 활동(meta/lastActive) 이후 ROOM_TTL_DAYS 일이 지난 방을 삭제한다.
// GitHub Actions 의 정기 실행용(.github/workflows/cleanup-rooms.yml). 수동 실행도 가능하다.
//
//   FIREBASE_SERVICE_ACCOUNT  서비스 계정 키 JSON 전체 (에뮬레이터에서는 불필요)
//   DATABASE_URL              (선택) 기본값은 .env.production 의 VITE_FIREBASE_DATABASE_URL
//   ROOM_TTL_DAYS             (선택) 기본 30
//   DRY_RUN=1                 지우지 않고 대상만 출력
//
//   node scripts/cleanup-rooms.mjs
// 사용 전: npm install --no-save firebase-admin
import fs from 'node:fs';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const DAY = 24 * 60 * 60 * 1000;
const ttlDays = Number(process.env.ROOM_TTL_DAYS ?? 30);
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST; // 예: 127.0.0.1:9000

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const m = fs.readFileSync(new URL('../.env.production', import.meta.url), 'utf8').match(/^VITE_FIREBASE_DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* 아래 오류로 */
  }
  throw new Error('DATABASE_URL 이 필요합니다');
}

const url = emulator ? 'https://demo-onlinedraw-default-rtdb.firebaseio.com' : databaseUrl();
let credential;
if (!emulator) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT 가 필요합니다');
  credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
}
const app = initializeApp(emulator ? { databaseURL: url, projectId: 'demo-onlinedraw' } : { credential, databaseURL: url });
const db = getDatabase(app);

/** 방 ID 목록만 가져온다 (shallow: 방 전체 데이터를 내려받지 않는다). Admin SDK 에는 shallow 가 없어 REST 를 쓴다. */
async function listRoomIds() {
  let base;
  let q = 'shallow=true';
  if (emulator) {
    base = `http://${emulator}`;
    q += '&ns=demo-onlinedraw-default-rtdb&access_token=owner';
  } else {
    base = url.replace(/\/$/, '');
    q += `&access_token=${encodeURIComponent((await credential.getAccessToken()).access_token)}`;
  }
  const res = await fetch(`${base}/rooms.json?${q}`);
  if (!res.ok) throw new Error(`방 목록 조회 실패: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data ? Object.keys(data) : [];
}

const now = Date.now();
const ids = await listRoomIds();
let deleted = 0;
let kept = 0;
for (const id of ids) {
  const [metaSnap, presenceSnap] = await Promise.all([db.ref(`rooms/${id}/meta`).get(), db.ref(`rooms/${id}/presence`).get()]);
  const meta = metaSnap.val();
  const last = Math.max(Number(meta?.lastActive) || 0, Number(meta?.createdAt) || 0, Number(meta?.clearedAt) || 0);
  const ageDays = last ? (now - last) / DAY : Infinity; // 메타가 없는 방은 쓸모없는 조각이므로 만료로 본다
  if (presenceSnap.exists()) {
    kept++; // 지금 접속 중인 사람이 있으면 건드리지 않는다
    continue;
  }
  if (ageDays > ttlDays) {
    console.log(`${dryRun ? '[dry-run] ' : ''}삭제: ${id}  (마지막 활동 ${Number.isFinite(ageDays) ? ageDays.toFixed(1) + '일 전' : '기록 없음'})`);
    if (!dryRun) await db.ref(`rooms/${id}`).remove();
    deleted++;
  } else {
    kept++;
  }
}
console.log(`완료: 전체 ${ids.length}개 중 ${dryRun ? '삭제 대상' : '삭제'} ${deleted}개, 유지 ${kept}개 (기준 ${ttlDays}일)`);
await deleteApp(app);
