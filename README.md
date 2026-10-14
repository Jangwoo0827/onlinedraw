# 같이 그리기 (onlinedraw)

링크만으로 입장해 여러 명이 같은 캔버스에 동시에 그리는 모바일 우선 웹앱.
Vite + TypeScript + Canvas 2D (+ Firebase, STEP 3부터).

## 진행 상황
- [x] STEP 1. 로컬 캔버스 (펜/지우개, 색상, 굵기, 실행 취소/다시 실행, 핀치 줌)
- [x] STEP 2. 획 모델/렌더링 엔진 (레이어 캐싱, 증분/전체 렌더링 분리)
- [ ] STEP 3. Firebase 연동
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
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | 실행 취소 / 다시 실행 |
| P / E / 0 | 펜 / 지우개 / 전체 보기 |

## 모바일 테스트
1. 폰과 PC를 같은 와이파이에 연결하고 `npm run dev` 실행.
2. 터미널에 나온 `Network: http://192.168.x.x:5173/` 주소를 폰 브라우저에서 열기.
   (접속이 안 되면 PC 방화벽에서 5173 포트 허용)
3. 폰 2대(또는 폰+PC) 동시 그리기는 STEP 3(방 동기화) 이후부터 가능. 같은 `?room=` 링크를 두 기기에서 열면 된다.
4. PC에서 터치 시뮬레이션: Chrome 개발자도구 → 기기 툴바 → Shift+드래그로 두 손가락 핀치.
