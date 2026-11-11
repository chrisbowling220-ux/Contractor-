import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.tsx'
import ErrorBoundary from './lib/ErrorBoundary'
import OfflineNotice from './lib/OfflineNotice'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (!PUBLISHABLE_KEY) {
  // A build without the sign-in key used to fail as a blank page with an error
  // only in the console. Say what is wrong where the person deploying sees it.
  root.render(
    <div role="alert" style={{ padding: '32px', fontFamily: 'system-ui, sans-serif', maxWidth: '520px', margin: '10vh auto' }}>
      <h1 style={{ fontSize: '20px' }}>BuildPro+ is not configured</h1>
      <p style={{ color: '#64748b', lineHeight: 1.5 }}>
        The sign-in key (VITE_CLERK_PUBLISHABLE_KEY) is missing from this build. Add it to the environment file and rebuild.
      </p>
    </div>,
  )
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <OfflineNotice />
        <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
          <App />
        </ClerkProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  )
}
