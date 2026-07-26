import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/lib/**'],
      // The domain and lib modules are pure and carry the logic that has actually broken
      // in this repo, so they are held to a real bar. UI coverage is a separate problem.
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
