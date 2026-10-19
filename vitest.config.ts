import { configDefaults, defineConfig } from 'vitest/config'

// Unit tests. Firestore rules tests need the emulator, so they run separately
// via `npm run test:rules` (vitest.rules.config.ts).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.rules.test.ts'],
  },
})
