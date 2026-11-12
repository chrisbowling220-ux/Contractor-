import { defineConfig } from 'vitest/config'

// Firestore security-rules tests. Run inside the emulator:
//   npm run test:rules
export default defineConfig({
  test: {
    include: ['**/*.rules.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 30000,
    // Every file talks to the one emulator; run them one at a time. In
    // parallel on a busy 4-core machine the emulator times out its own
    // transactions and unrelated tests fail.
    fileParallelism: false,
  },
})
