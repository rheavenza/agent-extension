import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': new URL('.', import.meta.url).pathname.replace(/\/$/, '') } },
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] },
});
