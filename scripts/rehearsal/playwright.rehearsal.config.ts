// Release rehearsal (see rehearse-release.sh). Not part of `npm run test:e2e`.
// Real customer data is in the emulator here, so nothing is kept on failure
// (no traces, screenshots or videos) and the browser may only talk to this
// machine.
import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const repo = resolve(import.meta.dirname, '../..')
const out = process.env.REHEARSAL_OUT || '/tmp/bp-rehearsal'
const emulatorEnv = {
  VITE_USE_EMULATORS: '1',
  VITE_EMULATOR_FIRESTORE_PORT: '8580',
  VITE_EMULATOR_STORAGE_PORT: '9599',
  VITE_EMULATOR_AUTH_PORT: '9699',
  VITE_FIREBASE_PROJECT_ID: 'demo-rehearsal',
  VITE_FIREBASE_API_KEY: 'demo-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-rehearsal.firebaseapp.com',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-rehearsal.appspot.com',
  VITE_FIREBASE_APP_ID: '1:1:web:demo',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_e2e_stub',
}

// The new app (this checkout) always; the app that is live today when
// REHEARSAL_OLD_APP_DIR points at a checkout of it (prepared by the script).
const servers = [{
  command: 'npx vite --config e2e/vite.e2e.config.ts --port 5299',
  cwd: repo,
  url: 'http://127.0.0.1:5299',
  reuseExistingServer: false,
  timeout: 180_000,
  env: emulatorEnv,
}]
if (process.env.REHEARSAL_OLD_APP_DIR) {
  servers.push({
    command: 'npx vite --config e2e/vite.e2e.config.ts --port 5298',
    cwd: process.env.REHEARSAL_OLD_APP_DIR,
    url: 'http://127.0.0.1:5298',
    reuseExistingServer: false,
    timeout: 180_000,
    env: emulatorEnv,
  })
}

export default defineConfig({
  testDir: '.',
  testMatch: 'release-rehearsal.spec.ts',
  outputDir: `${out}/playwright`,
  timeout: 120 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: servers,
})
