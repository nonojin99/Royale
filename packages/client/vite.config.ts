import { defineConfig } from 'vite';

export default defineConfig({
  // 정적 호스팅(GitHub Pages 등) 하위 경로에서도 동작하도록 상대 경로로 뽑는다
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
