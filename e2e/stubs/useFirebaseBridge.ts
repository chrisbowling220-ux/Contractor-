// Test stand-in for src/lib/useFirebaseBridge. The real one exchanges a sign-in
// token for a Firebase token through a Cloud Function. Here we sign straight
// into the Firebase AUTH EMULATOR as the throwaway account (the emulator accepts
// an unsigned token), so Firestore and Storage rules see request.auth.uid
// exactly as they do in production and are enforced for real.
import { useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithCustomToken, signOut } from 'firebase/auth'
import { firebaseAuth } from '../../src/firebase'
import { useAuth } from './clerk'

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function emulatorToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000)
  const account = 'firebase-auth-emulator@example.com'
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: account, sub: account, uid, iat: now, exp: now + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  })}.`
}

export function useFirebaseBridge(): { ready: boolean; error: string | null } {
  const { isSignedIn, userId } = useAuth()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const unsub = onAuthStateChanged(firebaseAuth, u => setReady(!!u && u.uid === userId))
    ;(async () => {
      try {
        if (isSignedIn && userId) {
          if (firebaseAuth.currentUser?.uid !== userId) await signInWithCustomToken(firebaseAuth, emulatorToken(userId))
        } else if (firebaseAuth.currentUser) {
          await signOut(firebaseAuth)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Auth bridge failed')
      }
    })()
    return () => unsub()
  }, [isSignedIn, userId])
  return { ready, error }
}
