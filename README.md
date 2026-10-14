# 같이 그리기 (onlinedraw)

링크만으로 입장해 여러 명이 같은 캔버스에 동시에 그리는 모바일 우선 웹앱.
Vite + TypeScript + Canvas 2D (+ Firebase, STEP 3부터).

## 진행 상황
- [x] STEP 1. 로컬 캔버스 (펜/지우개, 색상, 굵기, 실행 취소/다시 실행, 핀치 줌)
- [x] STEP 2. 획 모델/렌더링 엔진 (레이어 캐싱, 증분/전체 렌더링 분리)
- [x] STEP 3. Firebase 연동 (방 동기화, 재연결)
- [ ] STEP 4. 참가자 표시
- [ ] STEP 5. 마무리 기능
- [ ] STEP 6. 보안 규칙/배포

## 렌더링 구조 (`src/canvas/`)
| 파일 | 역할 |
| --- | --- |
| `store.ts` | 확정된 획 배열 + 실행 취소/다시 실행. 모든 그림의 원본 데이터 |
| `stroke-draw.ts` | 획 하나를 그리는 함수들 (구간 단위 증분 / 전체). 지우개 획은 `destination-out` |
| `stroke-cache.ts` | 오프스크린 캔버스 한 장. `drawStroke`/`drawSegmentsFrom`(증분)과 `renderAll`/`renderSliced`(전체) |
| `renderer.ts` | 레이어 합성. **base**(확정 획, 논리 고정 해상도) · **detail**(확정 획, 현재 뷰 해상도) · **live**(진행 중 획) |

- 그리는 중: live 에만 새 구간을 덧그림 → 합성. 확정되면 base/detail 에 그 획만 덧그림.
- 핀치/이동 중: base 를 변환해서 합성만 함(획 수와 무관). 멈추면(120ms) detail 을 프레임당 일정 분량씩 나눠 다시 그려 선명하게 교체.
- 실행 취소: base 를 백버퍼에 나눠 다시 그린 뒤 교체, 이어서 detail 재생성. 그리는 중 취소(두 번째 손가락)는 live 만 비움.

## 방 동기화 (`src/sync/`, `src/firebase/`)
- 처음 열면 `?room=랜덤ID` 가 URL 에 붙는다. 이 주소를 공유하면 같은 방에 입장한다. 로그인은 익명 자동.
- **내 획**: 로컬에서 즉시 그린다. 그리는 동안 약 50ms 단위로 포인트 묶음을 `live` 에 올려 상대 화면에 그려지는 중으로 보이고,
  끝나면 RDP 로 점을 줄인 최종 획을 `strokes` 에 쓰면서 `live` 를 지운다(원자적 update 1회).
- **받기**: 입장 시 기존 획 전체를 `createdAt`(서버 타임스탬프) 순으로 받고, 이후 child_added/changed/removed 로 실시간 반영.
  늦게 도착한 획이 중간 순서에 끼면 전체 다시 그리기로 순서를 통일한다.
- **끊김**: 상단에 `연결됨 / 재연결 중… · 전송 대기 n` 표시. 끊긴 동안 그린 획은 화면에 바로 보이고 복귀 후 자동 전송된다.
  (SDK 쓰기 큐 사용 — 끊긴 상태에서 새로고침/탭 종료를 하면 아직 못 보낸 획은 사라진다.)
- 그리다 끊기면 `onDisconnect` 가 서버의 `live` 항목을 치운다.

```
rooms/{room}/meta                 { createdAt, createdBy }
rooms/{room}/strokes/{strokeId}   { uid, color, size, tool, createdAt, n, pts: "x,y;x,y,p;..." }
rooms/{room}/live/{strokeId}      { uid, color, size, tool, pts: { p0000: "x,y;...", p0001: "..." } }   # 진행 중, 확정되면 삭제
```

## Firebase 설정
1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성.
2. **Authentication → 로그인 방법 → 익명** 사용 설정.
3. **Realtime Database → 데이터베이스 만들기**(잠금 모드). **규칙** 탭에 `database.rules.json` 내용을 붙여넣고 게시
   (지금은 "로그인한 사용자만 읽기/쓰기"인 임시 규칙이며, 제대로 된 규칙은 STEP 6).
4. **프로젝트 설정 → 내 앱 → 웹 앱 추가** 후 SDK 설정값을 `.env.example` 을 복사한 `.env` 에 채우기.
5. `npm run dev` → 주소에 `?room=...` 이 붙으면 성공. 상단에 "● 연결됨"이 보여야 한다.

설정값이 없으면 앱은 혼자 그리는 **로컬 모드**로 동작한다(상단에 "로컬 모드" 표시).

## GitHub Pages 배포
`.github/workflows/deploy.yml` 이 `main` 브랜치에 푸시될 때마다 빌드해서 Pages 에 올린다. 사이트 주소: `https://<깃허브아이디>.github.io/onlinedraw/`
(빌드는 상대 경로(`base: './'`)라서 하위 경로에서도 동작한다. Firebase 웹 설정은 `.env.production` 에서 읽는다.)

1. 작업 브랜치를 `main` 에 머지한다 (Pages 배포는 `main` 에서만 허용됨).
2. GitHub 저장소 → **Settings → Pages → Build and deployment → Source: GitHub Actions** 로 변경.
3. **Actions** 탭에서 `Deploy to GitHub Pages` 가 초록색으로 끝나면 위 주소로 접속된다. (처음에는 수동으로 *Run workflow* 해도 된다.)
4. Firebase 콘솔 → **Authentication → Settings(설정) → 승인된 도메인** 에 `<깃허브아이디>.github.io` 를 추가한다.
5. (권장) Google Cloud 콘솔 → *APIs 및 서비스 → 사용자 인증 정보* 에서 웹 API 키의 **HTTP 리퍼러 제한** 을
   `https://<깃허브아이디>.github.io/*`, `http://localhost:*`, `http://192.168.*:*` 로 설정한다.

> 주의: 지금 `database.rules.json` 은 "로그인한 사용자 누구나 읽기/쓰기"인 **임시 규칙**이다.
> 주소를 불특정 다수에게 공개하기 전에 STEP 6 의 보안 규칙을 적용해야 한다.

## Firebase 없이 테스트 (에뮬레이터)
Java 11+ 가 필요하다.
```bash
echo "VITE_FIREBASE_EMULATOR=1" > .env.local
npm run emulators      # 터미널 1: Auth(9099) + Realtime Database(9000), 모든 인터페이스에 바인딩
npm run dev            # 터미널 2
```
폰에서 `http://PC의-LAN주소:5173` 으로 열면 에뮬레이터도 같은 호스트로 자동 접속한다(PC 방화벽에서 5173/9000/9099 허용).

## 실행
```bash
npm install
npm run dev        # http://localhost:5173  (Network 주소도 함께 출력됨)
npm run build      # 타입 검사 + 프로덕션 빌드
```

## 조작
| 입력 | 동작 |
| --- | --- |
| 터치 한 손가락 / 마우스 / 펜 | 그리기 (펜은 필압 반영) |
| 터치 두 손가락 | 이동 + 핀치 줌 (그리던 획은 취소) |
| 마우스 휠 / 트랙패드 핀치 | 줌 |
| 마우스 가운데·오른쪽 버튼 드래그, Space+드래그 | 이동 |
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | 내 획만 실행 취소 / 다시 실행 (다른 사람 획은 그대로) |
| P / E / 0 | 펜 / 지우개 / 전체 보기 |

## 모바일 테스트
1. 폰과 PC를 같은 와이파이에 연결하고 `npm run dev` 실행.
2. 터미널에 나온 `Network: http://192.168.x.x:5173/` 주소를 폰 브라우저에서 열기.
   (접속이 안 되면 PC 방화벽에서 5173 포트 허용)
3. **폰 2대(또는 폰+PC) 동시 그리기**: 한 기기에서 주소를 열면 `?room=...` 이 붙는다. 그 전체 주소를 다른 기기에서 열면 같은 방이다.
   확인할 것: 한쪽에서 그리는 도중 다른 쪽에 선이 따라오는지, 비행기 모드로 끊었다 켜면 "재연결 중"→"연결됨" 후 끊긴 동안 그린 획이 넘어가는지.
4. PC에서 터치 시뮬레이션: Chrome 개발자도구 → 기기 툴바 → Shift+드래그로 두 손가락 핀치.
