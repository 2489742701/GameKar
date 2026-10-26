import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (dir: string) => fileURLToPath(new URL(`./src/${dir}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': src('engine'),
      '@game': src('game'),
      '@ui': src('ui'),
      '@arena': src('arena'),
    },
  },
  server: {
    host: true,
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // 两个入口：index.html 是老模式（抽卡 RTS），arena.html 是对战模式
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        arena: fileURLToPath(new URL('./arena.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
