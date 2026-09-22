import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'services/api/**/*.test.ts', 'services/scrapers/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
