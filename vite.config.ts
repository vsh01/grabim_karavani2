import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути, чтобы собранную игру можно было открыть из любой папки.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
