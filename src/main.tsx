import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { ErrorBoundary, FullScreenNotice, MissingConfigScreen, type EnvRequirement } from './StartupScreens'
import './index.css'

// This is a Vite build: every VITE_* value is inlined at BUILD time. If the
// production build shipped without them (missing/empty .env when `vite build`
// ran), Clerk and Firebase throw during module initialization and the page
// renders as a blank white screen with nothing to explain why. We detect a
// missing/broken config up front and show a readable message instead of the
// silent white screen — and we load the rest of the app lazily so a throw
// inside Firebase's import-time init becomes a catchable error rather than a
// dead page.

const REQUIRED_ENV: EnvRequirement[] = [
  { key: 'VITE_CLERK_PUBLISHABLE_KEY', value: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY, label: 'Clerk (sign-in)' },
  { key: 'VITE_FIREBASE_API_KEY', value: import.meta.env.VITE_FIREBASE_API_KEY, label: 'Firebase API key' },
  { key: 'VITE_FIREBASE_PROJECT_ID', value: import.meta.env.VITE_FIREBASE_PROJECT_ID, label: 'Firebase project id' },
  { key: 'VITE_FIREBASE_APP_ID', value: import.meta.env.VITE_FIREBASE_APP_ID, label: 'Firebase app id' },
]

const missingEnv = REQUIRED_ENV.filter(e => !e.value || !String(e.value).trim())

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (missingEnv.length > 0) {
  root.render(<MissingConfigScreen missing={missingEnv} />)
} else {
  // Config looks present. Load the app lazily: importing App pulls in
  // src/firebase.ts, whose getAuth()/getFirestore() init throws synchronously
  // on a malformed config. A dynamic import turns that throw into a rejected
  // promise we can catch and surface, instead of an uncaught error that leaves
  // the page blank.
  import('./App.tsx')
    .then(({ default: App }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
              <App />
            </ClerkProvider>
          </ErrorBoundary>
        </React.StrictMode>,
      )
    })
    .catch(err => {
      console.error('Failed to start BuildPro+:', err)
      root.render(
        <FullScreenNotice
          title="BuildPro+ couldn't start"
          body="The app loaded but couldn't connect to its services. This usually means the Firebase or sign-in configuration is incorrect."
          showReload
        />,
      )
    })
}
