import { defineConfig } from 'vitest/config'

// Firestore security-rules tests. Run inside the emulator:
//   npm run test:rules
export default defineConfig({
  test: {
    include: ['**/*.rules.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 20000,
  },
})
