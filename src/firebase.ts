import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { connectStorageEmulator, getStorage } from 'firebase/storage'
import { connectAuthEmulator, getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const functions = getFunctions(app)
export const storage = getStorage(app)
export const firebaseAuth = getAuth(app)

// Local development and browser tests can run against the Firebase emulators
// instead of the live project, so nothing they do touches real customer data:
//
//   VITE_USE_EMULATORS=1 npm run dev      (with `firebase emulators:start` running)
//
// Only honoured by the dev server. A production build ignores the flag
// entirely (import.meta.env.DEV is false and this block is compiled out).
if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === '1') {
  // The automated tests use their own ports (firebase.test.json) so they do
  // not collide with other emulators running on this machine.
  const port = (name: string, fallback: number) => Number(import.meta.env[`VITE_EMULATOR_${name}_PORT`]) || fallback
  connectFirestoreEmulator(db, '127.0.0.1', port('FIRESTORE', 8080))
  connectStorageEmulator(storage, '127.0.0.1', port('STORAGE', 9199))
  connectFunctionsEmulator(functions, '127.0.0.1', port('FUNCTIONS', 5001))
  connectAuthEmulator(firebaseAuth, `http://127.0.0.1:${port('AUTH', 9099)}`, { disableWarnings: true })
  console.info('[BuildPro+] Using local Firebase emulators — not the live project.')
}
