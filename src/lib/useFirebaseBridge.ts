import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut, onAuthStateChanged } from 'firebase/auth'
import { firebaseAuth, functions } from '../firebase'

const exchangeFirebaseTokenCallable = httpsCallable<{ clerkToken: string }, { token: string }>(
  functions,
  'exchangeFirebaseToken',
)

// Bridges Clerk auth → Firebase auth. Because the app signs users in with
// Clerk (not Firebase Auth), Firebase Security Rules would otherwise see no
// authenticated user. This hook exchanges the Clerk token for a Firebase
// custom token (minted server-side with uid == Clerk user id) and signs into
// Firebase, so request.auth.uid in Storage/Firestore rules == the Clerk id.
//
// Returns `ready`: true once a Firebase session matching the signed-in Clerk
// user exists. Gate all Firestore/Storage reads & writes on this so they don't
// fire before rules can authorize them.
export function useFirebaseBridge(): { ready: boolean; error: string | null } {
  const { getToken, isSignedIn, userId, isLoaded } = useAuth()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isLoaded) return
    let cancelled = false

    // Keep `ready` in sync with the actual Firebase session.
    const unsub = onAuthStateChanged(firebaseAuth, fbUser => {
      if (cancelled) return
      setReady(!!fbUser && fbUser.uid === userId)
    })

    const sync = async () => {
      try {
        if (isSignedIn && userId) {
          // Already signed into Firebase as this user? Nothing to do.
          if (firebaseAuth.currentUser?.uid === userId) {
            setReady(true)
            return
          }
          const clerkToken = await getToken()
          if (!clerkToken) throw new Error('No Clerk token')
          const res = await exchangeFirebaseTokenCallable({ clerkToken })
          if (cancelled) return
          await signInWithCustomToken(firebaseAuth, res.data.token)
          setError(null)
        } else {
          // Clerk signed out → tear down the Firebase session too.
          if (firebaseAuth.currentUser) await signOut(firebaseAuth)
          setReady(false)
        }
      } catch (err) {
        console.error('Firebase bridge failed:', err)
        if (!cancelled) setError(err instanceof Error ? err.message : 'Auth bridge failed')
      }
    }
    sync()

    return () => { cancelled = true; unsub() }
  }, [isLoaded, isSignedIn, userId, getToken])

  return { ready, error }
}
