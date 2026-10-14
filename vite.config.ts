import { defineConfig } from 'vite';

export default defineConfig({
  // 상대 경로로 빌드해서 GitHub Pages 의 하위 경로(/onlinedraw/)와 루트 어디에 올려도 동작한다
  base: './',
  server: { host: true, port: 5173 },
});
