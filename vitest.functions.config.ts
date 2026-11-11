import { defineConfig } from 'vitest/config'

// Cloud Functions tests. They run the real functions against the Firestore
// emulator with the paid outside services replaced by stand-ins
// (functions/test/mocks.ts):
//   npm run test:functions
export default defineConfig({
  test: {
    include: ['functions/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // One shared emulator database: run the files one after another.
    fileParallelism: false,
    setupFiles: ['functions/test/mocks.ts'],
    env: { GCLOUD_PROJECT: 'demo-buildpro-fn' },
  },
})
