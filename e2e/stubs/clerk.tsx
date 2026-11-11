// Stand-in for @clerk/clerk-react, used ONLY by the browser tests
// (e2e/vite.e2e.config.ts swaps it in). It gives the app a fixed throwaway
// account so the tests can sign in and out without touching the real sign-in
// service. It is never part of a normal dev or production build.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export const E2E_USER = {
  id: 'user_e2e_contractor',
  firstName: 'Terry',
  fullName: 'Terry Tester',
  primaryEmailAddress: { emailAddress: 'terry@example.test' },
}

const KEY = 'e2e_signed_in'
const Ctx = createContext<{ signedIn: boolean; setSignedIn: (v: boolean) => void }>({ signedIn: false, setSignedIn: () => {} })

export function ClerkProvider({ children }: { children: ReactNode; publishableKey?: string }) {
  const [signedIn, setState] = useState(() => window.localStorage.getItem(KEY) === '1')
  const setSignedIn = useCallback((v: boolean) => {
    window.localStorage.setItem(KEY, v ? '1' : '0')
    setState(v)
  }, [])
  useEffect(() => { document.documentElement.dataset.e2eAuth = signedIn ? 'in' : 'out' }, [signedIn])
  return <Ctx.Provider value={{ signedIn, setSignedIn }}>{children}</Ctx.Provider>
}

export const SignedIn = ({ children }: { children: ReactNode }) => (useContext(Ctx).signedIn ? <>{children}</> : null)
export const SignedOut = ({ children }: { children: ReactNode }) => (useContext(Ctx).signedIn ? null : <>{children}</>)

function AuthButton({ children, label }: { children?: ReactNode; label: string }) {
  const { setSignedIn } = useContext(Ctx)
  return <span onClick={() => setSignedIn(true)} data-e2e={label}>{children ?? <button>{label}</button>}</span>
}
export const SignInButton = ({ children }: { children?: ReactNode; mode?: string }) => <AuthButton label="Sign In">{children}</AuthButton>
export const SignUpButton = ({ children }: { children?: ReactNode; mode?: string }) => <AuthButton label="Sign Up">{children}</AuthButton>

export function UserButton() {
  const { setSignedIn } = useContext(Ctx)
  return <button onClick={() => setSignedIn(false)}>Sign out</button>
}

export function useUser() {
  const { signedIn } = useContext(Ctx)
  return { isLoaded: true, isSignedIn: signedIn, user: signedIn ? E2E_USER : null }
}

export function useAuth() {
  const { signedIn, setSignedIn } = useContext(Ctx)
  const getToken = useCallback(async () => (signedIn ? 'e2e-token' : null), [signedIn])
  const signOut = useCallback(async () => setSignedIn(false), [setSignedIn])
  return { isLoaded: true, isSignedIn: signedIn, userId: signedIn ? E2E_USER.id : null, getToken, signOut }
}
