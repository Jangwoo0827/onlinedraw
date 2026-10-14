// 앱 셸 캐시용 서비스 워커. 홈 화면에 추가한 앱이 오프라인에서도 열리게 하고, 해시된 정적 파일은 캐시를 우선 사용한다.
// Firebase 등 다른 출처의 요청은 건드리지 않는다.
const CACHE = 'onlinedraw-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // 페이지: 네트워크 우선(새 배포를 바로 받기 위해), 실패하면 캐시된 셸
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy, { ignoreSearch: true }).catch(() => {}));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./', { ignoreSearch: true }))),
    );
    return;
  }

  // 정적 파일: 캐시 우선, 없으면 받아서 저장 (빌드 파일 이름에 해시가 들어 있어 안전)
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
