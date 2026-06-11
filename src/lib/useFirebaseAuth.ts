import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { signInWithCustomToken, signOut, onAuthStateChanged } from 'firebase/auth'
import { auth } from '../firebase'

export type FirebaseAuthStatus = 'loading' | 'ready' | 'error'

// ─────────────────────────────────────────────────────────────────────────────
// Clerk → Firebase Auth bridge
//
// The app authenticates users with Clerk, but Firestore security rules can only
// see a *Firebase* identity. This hook closes that gap:
//
//   1. When a user is signed in with Clerk, we ask Clerk for a Firebase custom
//      token using the "integration_firebase" JWT template.
//   2. We sign into Firebase with that token. Clerk sets the token's `uid` to
//      the Clerk user id — the same value we write to every document's
//      `createdBy` field — so the rules in firestore.rules can match
//      `request.auth.uid == resource.data.createdBy`.
//   3. When the user signs out of Clerk, we sign them out of Firebase too.
//
// ONE-TIME SETUP (Clerk dashboard → Integrations → Firebase):
//   - Enable the Firebase integration and upload your Firebase service account.
//   - That creates the "integration_firebase" token template this hook uses.
// Until that switch is flipped, getToken() returns null and this hook reports
// status 'error' with a clear message (surfaced by the AuthGate in App.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export function useFirebaseAuth(): { status: FirebaseAuthStatus; error: string } {
  const { getToken, isSignedIn } = useAuth()
  const [status, setStatus] = useState<FirebaseAuthStatus>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function bridge() {
      if (!isSignedIn) {
        await signOut(auth).catch(() => {})
        return
      }
      // Already bridged on a previous render — nothing to do.
      if (auth.currentUser) {
        if (!cancelled) setStatus('ready')
        return
      }
      setStatus('loading')
      try {
        const token = await getToken({ template: 'integration_firebase' })
        if (!token) {
          throw new Error(
            'Clerk did not return a Firebase token. Enable the Firebase integration in the Clerk dashboard (Integrations → Firebase).',
          )
        }
        await signInWithCustomToken(auth, token)
        if (!cancelled) {
          setStatus('ready')
          setError('')
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setError(err instanceof Error ? err.message : 'Could not connect to the database.')
        }
      }
    }

    bridge()
    return () => {
      cancelled = true
    }
  }, [isSignedIn, getToken])

  // Keep status in sync if Firebase establishes or drops a session out of band.
  useEffect(
    () =>
      onAuthStateChanged(auth, user => {
        if (user) setStatus('ready')
      }),
    [],
  )

  return { status, error }
}
