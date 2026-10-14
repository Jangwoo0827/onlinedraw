# 같이 그리기 (onlinedraw)

링크 하나로 여럿이 **아주 큰 캔버스**(16000×16000, r/place 처럼)에 실시간으로 같이 그리는 모바일 우선 웹앱.
Vite + TypeScript + Canvas 2D, Firebase(익명 로그인 + Realtime Database), GitHub Pages 배포, PWA(홈 화면 추가).

## 진행 상황
- [x] STEP 1. 로컬 캔버스 (펜/지우개, 색상, 굵기, 실행 취소/다시 실행, 핀치 줌)
- [x] STEP 2. 획 모델/렌더링 엔진 (레이어 캐싱, 증분/전체 렌더링 분리)
- [x] STEP 3. Firebase 연동 (방 동기화, 재연결)
- [x] STEP 4. 참가자 표시 (접속 목록, 닉네임, 커서)
- [x] STEP 5. 마무리 기능 (전체 지우기, PNG, 링크 복사, 보기 전용, 방 만료 정리)
- [x] STEP 6. 보안 규칙 + 배포 (GitHub Pages) + PWA

## 사용법
처음 열면 주소에 `?room=방ID&k=편집키` 가 붙는다. 이 주소가 **편집 링크**(같이 그리기)다.
우측 상단 ⋮ 메뉴에서 **편집 링크 복사 / 보기 전용 링크 복사 / PNG 로 저장 / 전체 지우기** 를 쓴다.

| 입력 | 동작 |
| --- | --- |
| 터치 한 손가락 / 마우스 / 펜 | 그리기 (펜은 필압 반영) |
| 터치 두 손가락 | 이동 + 핀치 줌 (그리던 획은 취소) |
| 마우스 휠 / 트랙패드 핀치 | 줌 |
| 마우스 가운데·오른쪽 버튼 드래그, Space+드래그 | 이동 |
| 왼쪽 아래 미니맵 | 누르거나 끌어서 판 어디로든 이동 |
| 👥 참가자 | 접속 중인 사람, 내 닉네임 수정, 이름을 누르면 그 사람 위치로 이동 |
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | 내 획만 실행 취소 / 다시 실행 |
| P / E / 0 | 펜 / 지우개 / 캔버스 전체 보기 |

- **보기 전용 링크**(`?room=방ID`, 키 없음)로 들어온 사람은 그릴 수 없고 이동/확대만 할 수 있다. 서버 보안 규칙이 강제한다.
- **전체 지우기**는 확인 창을 거친다. 모든 참가자의 화면에서 지워진다.

## 큰 캔버스와 렌더링 (`src/canvas/`)
판은 16000×16000 논리 좌표(`constants.ts`). 모든 획은 이 좌표로 저장되어 기기 화면과 무관하게 같게 보인다.

| 레이어 | 역할 |
| --- | --- |
| overview | 판 전체의 확정 획을 저해상도(긴 변 2048px)로 항상 최신 유지. 멀리서 볼 때·이동/줌 중에 사용 |
| detail | 현재 배율의 정밀 그림. 화면의 1.5배 영역만, **보이는 영역과 겹치는 획만** 그린다. 뷰가 멈추면 뒷버퍼에 시간을 쪼개 그려 교체 |
| live / remote | 지금 그리는 내 획 / 다른 사람이 지금 그리는 획 (증분) |

- 획마다 경계 상자(bounds)를 캐시해서 화면 밖 획은 그리지 않는다.
- 실행 취소·삭제·순서 변경은 그 획의 **영역만** 다시 그린다(전체 다시 그리기 없음). 획 2만 개에서도 이동은 vsync 한계, 삭제는 수 ms.
- 멀리서 봐도 선이 사라지지 않도록 최소 1 기기 픽셀 굵기를 보장한다.
- 입장하면 판 한가운데에서 시작하고, 이미 그림이 있는 방은 그림이 있는 곳으로 자동 이동한다.

## 방 동기화와 권한 (`src/sync/`, `src/firebase/`)
```
rooms/{room}/meta                 { createdAt, createdBy, count(확정 획 수), lastActive, clearedAt }
rooms/{room}/secret/editKey       편집 키 (읽기 불가, 한 번만 기록)
rooms/{room}/editors/{uid}        편집 키를 제시해 등록된 편집자 (읽기 불가)
rooms/{room}/strokes/{id}         { uid, color, size, tool, createdAt(서버 시각), n, pts: "x,y;x,y,p;..." }
rooms/{room}/live/{id}            진행 중인 획 { ..., pts: { p0000: "...", p0001: "..." } } — 확정되면 삭제
rooms/{room}/presence/{uid}       { name, color, edit, t }   접속 중에만 존재 (onDisconnect 로 제거)
rooms/{room}/cursors/{uid}        { x, y }                   약 100ms 단위로 갱신
```
- **내 획**: 로컬에서 즉시 그린다. 그리는 동안 약 50ms 단위로 포인트 묶음을 `live` 에 올리고, 끝나면 RDP 로 점을 줄인 최종 획을
  `strokes` 에 쓰면서 `live` 를 지운다(원자적 update 1회). 획 하나가 1500점을 넘으면 자동으로 이어서 새 획으로 나눈다.
- **받기**: 입장 시 기존 획 전체를 `createdAt`(서버 타임스탬프) 순으로 받고 이후 실시간 반영. 늦게 도착한 획이 중간에 끼면 그 영역만 다시 그린다.
- **편집 권한**: 편집 키를 아는 사람만 `editors` 에 등록되어 그릴 수 있다. 키 없이(또는 틀린 키로) 들어오면 보기 전용.
- **연결 끊김**: 상단에 `연결됨 / 재연결 중… · 전송 대기 n` 표시. 끊긴 동안 그린 획은 화면에 바로 보이고 복귀 후 자동 전송된다
  (SDK 쓰기 큐 — 끊긴 채 새로고침/탭 종료하면 못 보낸 획은 사라진다). 복귀하면 접속 표시도 자동으로 다시 올라간다.
- **전체 지우기**: 규칙상 남의 획은 지울 수 없으므로 `meta/clearedAt` 마커만 남긴다. 모두의 화면에서 그 시각 이전 획이 사라지고,
  각 참가자가 **자기 획을 서버에서 정리**한다.
- **획 개수 상한**: 방당 20000개. 획을 만들 때마다 `meta/count` 를 정확히 +1 해야 하고 상한을 넘으면 규칙이 거부한다.

## 보안 규칙 (`database.rules.json`)
- 로그인(익명 포함)한 사용자만 읽기/쓰기. 방 목록은 열람 불가, `secret`/`editors` 는 읽기 불가.
- 획은 **편집자만, 본인 uid 로만 생성**. 수정 불가(불변), 삭제는 **본인 획만**(실행 취소). 서버 시각(`createdAt == now`)만 허용.
- 획 하나: 포인트 수 ≤ 1500, `pts` ≤ 32000자(숫자·`.,;-` 만), 굵기 1~200, 색은 `#rrggbb`, 도구는 pen/eraser, 정의되지 않은 필드 거부.
- `live`: 편집자 본인만, 묶음 이름 `pNNNN`·길이 ≤ 8000. 접속/커서: 본인 uid 만, 닉네임 1~20자, 좌표는 캔버스 범위.
- 한계: 편집 키를 가진 악의적 편집자는 방 안에서 도배(개수 상한까지)나 전체 지우기 마커를 쓸 수 있다. 키를 아는 사람 = 편집자라는 모델이다.

규칙 검증(에뮬레이터, 68개 허용/거부 케이스):
```bash
npm run emulators      # 터미널 1 (Java 11+ 필요)
npm run test:rules     # 터미널 2
```

## Firebase 설정
1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성.
2. **Authentication → 로그인 방법 → 익명** 사용 설정.
3. **Realtime Database → 데이터베이스 만들기**(잠금 모드) 후 **규칙** 탭에 `database.rules.json` 내용을 붙여넣고 **게시**.
   (CLI 로 하려면: `npx firebase-tools login` → `npx firebase-tools deploy --only database` — `.firebaserc`/`firebase.json` 포함)
4. **프로젝트 설정 → 내 앱 → 웹 앱 추가** 후 SDK 설정값을 `.env`(로컬 개발, `.env.example` 참고)와 `.env.production`(배포 빌드)에 채운다.
   이 값들은 브라우저에 공개되는 식별자이므로 커밋해도 되며, 접근 제어는 규칙이 한다.
5. **Authentication → 설정 → 승인된 도메인** 에 배포 도메인(`<아이디>.github.io`) 추가.
6. (권장) Google Cloud 콘솔 → *APIs 및 서비스 → 사용자 인증 정보* 에서 웹 API 키의 HTTP 리퍼러 제한:
   `https://<아이디>.github.io/*`, `https://<프로젝트ID>.firebaseapp.com/*`, `http://localhost:*`
   (IP 에는 `192.168.*` 같은 와일드카드를 쓸 수 없다. LAN 테스트는 `http://192.168.0.10:5173/*` 처럼 정확한 주소를 추가하거나 잠시 제한을 끈다.)

설정값이 없으면 앱은 혼자 그리는 **로컬 모드**로 동작한다(상단에 "로컬 모드" 표시).

## 배포 (GitHub Pages)
`.github/workflows/deploy.yml` 이 `main` 에 푸시될 때마다 빌드(타입 검사 포함)해서 Pages 에 올린다. 주소: `https://<아이디>.github.io/onlinedraw/`
(빌드는 상대 경로 `base: './'` 라서 하위 경로에서도 동작한다.)

1. 저장소 **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. `main` 에 머지하면 **Actions → Deploy to GitHub Pages** 가 실행된다. (수동 실행도 가능)
3. 배포 후 Firebase 콘솔에서 위 5번(승인된 도메인)을 확인한다.

> 규칙(`database.rules.json`)은 Pages 배포와 별개로 Firebase 콘솔에 게시해야 적용된다. 새 규칙은 새 앱 버전과 짝이다
> (편집 키 방식) — 앱을 배포한 뒤 규칙을 게시하면 된다.

## PWA
`public/manifest.webmanifest`, 아이콘, `public/sw.js`(앱 셸 캐시)가 포함되어 있어 모바일에서 **홈 화면에 추가**하면 앱처럼 열리고,
오프라인에서도 화면이 뜬다(그림 동기화는 연결 후). 서비스 워커는 배포 빌드에서만 등록된다.

## 방 만료 정리
Cloud Functions 없이, 마지막 활동(`meta/lastActive`) 후 **30일**이 지난 방을 GitHub Actions 가 주 1회 정리한다
(`.github/workflows/cleanup-rooms.yml`, `scripts/cleanup-rooms.mjs`). 접속자가 있는 방은 건드리지 않는다.

사용하려면 서비스 계정 키를 시크릿으로 등록한다 (등록하지 않으면 워크플로는 아무것도 하지 않고 성공 처리):
1. Firebase 콘솔 → 프로젝트 설정 → **서비스 계정 → 새 비공개 키 생성** (JSON 다운로드)
2. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**: 이름 `FIREBASE_SERVICE_ACCOUNT`, 값은 JSON 전체
3. Actions → *Cleanup expired rooms* → **Run workflow** 로 먼저 `dry_run` 으로 대상을 확인한다.

## 개발
```bash
npm install
npm run dev        # http://localhost:5173  (Network 주소도 함께 출력됨)
npm run build      # 타입 검사 + 프로덕션 빌드
```
계정 없이 에뮬레이터로 개발/테스트하려면 `.env.local` 에 `VITE_FIREBASE_EMULATOR=1` 을 쓰고 `npm run emulators` 를 함께 실행한다.
폰에서 `http://PC의-LAN주소:5173` 으로 열면 에뮬레이터도 같은 호스트로 자동 접속한다(방화벽에서 5173/9000/9099 허용).

### 모바일 / 여러 기기 테스트
1. 폰과 PC 를 같은 와이파이에 연결하고 `npm run dev`. 출력된 `Network: http://192.168.x.x:5173/` 를 폰에서 연다.
2. 한 기기에서 연 **주소 전체**(`?room=…&k=…` 포함)를 다른 기기에서 열면 같은 방에서 같이 그린다. 보기 전용을 확인하려면 메뉴의 보기 전용 링크를 연다.
3. 확인할 것: 그리는 도중 상대 화면에 선이 따라오는지 / 상대 커서와 이름표 / 비행기 모드로 끊었다 켜면 "재연결 중"→"연결됨" 후 끊긴 동안의 획 전송 /
   참가자 목록과 닉네임 수정 / 전체 지우기 / PNG 저장.
4. PC 에서 터치 시뮬레이션: Chrome 개발자도구 기기 모드, Shift+드래그로 두 손가락 핀치.
