import { ClerkProvider } from '@clerk/clerk-react'
import App from './App'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// The signed-in contractor app, wrapped in the sign-in provider. Loaded only
// when the visitor is on the app itself (see Root.tsx); customer share pages
// never pull this in.
export default function ContractorApp() {
  if (!PUBLISHABLE_KEY) {
    // A build without the sign-in key used to fail as a blank page with an
    // error only in the console. Say what is wrong where the person deploying
    // will see it.
    return (
      <div role="alert" style={{ padding: '32px', fontFamily: 'system-ui, sans-serif', maxWidth: '520px', margin: '10vh auto' }}>
        <h1 style={{ fontSize: '20px' }}>BuildPro+ is not configured</h1>
        <p style={{ color: '#475569', lineHeight: 1.5 }}>
          The sign-in key (VITE_CLERK_PUBLISHABLE_KEY) is missing from this build. Add it to the environment file and rebuild.
        </p>
      </div>
    )
  }
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <App />
    </ClerkProvider>
  )
}
