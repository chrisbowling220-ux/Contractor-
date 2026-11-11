// Dev-server config for the browser tests only: the normal app, with the
// sign-in service and the token bridge replaced by local stand-ins and every
// Firebase call pointed at the emulators (see src/firebase.ts).
import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config.ts'

export default mergeConfig(base, defineConfig({
  root: resolve(import.meta.dirname, '..'),
  resolve: {
    alias: [
      { find: '@clerk/clerk-react', replacement: resolve(import.meta.dirname, 'stubs/clerk.tsx') },
      { find: /^\.\/lib\/useFirebaseBridge$/, replacement: resolve(import.meta.dirname, 'stubs/useFirebaseBridge.ts') },
    ],
  },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
}))
