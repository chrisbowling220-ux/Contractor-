import { defineConfig, devices } from '@playwright/test'

// Browser tests. Run with `npm run test:e2e`, which starts the Firebase
// emulators around this. Everything runs against the emulators with a
// throwaway account; nothing here can reach the live project.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/warmup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,   // the tests share one emulator database
  retries: 1,   // the very first page load can beat the dev server's cold start
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], channel: 'chrome' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  webServer: {
    command: 'npx vite --config e2e/vite.e2e.config.ts',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_USE_EMULATORS: '1',
      VITE_EMULATOR_FIRESTORE_PORT: '8380',
      VITE_EMULATOR_STORAGE_PORT: '9499',
      VITE_EMULATOR_AUTH_PORT: '9399',
      VITE_FIREBASE_PROJECT_ID: 'demo-setaside',
      VITE_FIREBASE_API_KEY: 'demo-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-setaside.firebaseapp.com',
      VITE_FIREBASE_STORAGE_BUCKET: 'demo-setaside.appspot.com',
      VITE_FIREBASE_APP_ID: '1:1:web:demo',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_e2e_stub',
    },
  },
})
