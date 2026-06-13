import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.tsx'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (!PUBLISHABLE_KEY) {
  // Without a key, <ClerkProvider> throws and the whole page renders blank —
  // including the sign-in button. Surface a readable message instead so the
  // misconfiguration is obvious rather than a silent white screen.
  root.render(
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '40px', maxWidth: '640px', margin: '0 auto', color: '#1a1f2e' }}>
      <h1 style={{ color: '#f97316' }}>Configuration error</h1>
      <p>
        <code>VITE_CLERK_PUBLISHABLE_KEY</code> is not set, so sign-in can't load.
        Add it to a <code>.env</code> file and rebuild.
      </p>
    </div>,
  )
} else {
  root.render(
    <React.StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <App />
      </ClerkProvider>
    </React.StrictMode>,
  )
}
