import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

// Catches a crash anywhere in the screen below it and shows a way back,
// instead of leaving a blank white page (which on a phone looks like the app
// died and lost the work). The error is logged for whoever is debugging.
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BuildPro+ screen crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: '#f8fafc' }}>
        <div style={{ maxWidth: '440px', textAlign: 'center' }}>
          <h1 style={{ fontSize: '20px', color: '#1a1f2e', margin: '0 0 8px' }}>Something went wrong on this screen</h1>
          <p style={{ color: '#64748b', fontSize: '14px', lineHeight: 1.5, margin: '0 0 20px' }}>
            Anything you already saved is safe. Reload to pick up where you left off. If it keeps happening, tell us what you were doing when it broke.
          </p>
          <button onClick={() => window.location.reload()} style={{ background: '#f97316', color: 'white', border: 'none', padding: '14px 28px', borderRadius: '10px', fontWeight: 700, fontSize: '16px', cursor: 'pointer' }}>
            Reload
          </button>
          <p style={{ marginTop: '16px' }}>
            <a href="/" style={{ color: '#64748b', fontSize: '13px' }}>Back to the dashboard</a>
          </p>
        </div>
      </div>
    )
  }
}
