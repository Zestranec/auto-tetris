import { defineConfig } from 'vite';

export default defineConfig({
  base: '/auto-tetris/',

  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});