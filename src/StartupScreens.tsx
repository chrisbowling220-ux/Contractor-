import React from 'react'

// Full-screen startup states shown BEFORE (or instead of) the main app: a
// readable "not configured" message and a crash fallback, so a missing build
// config or a render-time throw never leaves the user on a blank white page.
// Kept in their own module so the entry (main.tsx) stays free of component
// definitions.

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

export interface EnvRequirement {
  key: string
  value: unknown
  label: string
}

// On-brand full-screen notice used for both "not configured" and unexpected
// runtime crashes — anything that would otherwise leave the user staring at a
// blank page.
export function FullScreenNotice({ title, body, detail, showReload }: {
  title: string
  body: string
  detail?: React.ReactNode
  showReload?: boolean
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: `linear-gradient(135deg, ${NAVY} 0%, #0f172a 100%)`, padding: '24px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '460px', width: '100%', textAlign: 'center', color: 'white' }}>
        <div style={{ width: '52px', height: '52px', background: ORANGE, borderRadius: '14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', fontWeight: 800, color: 'white', boxShadow: '0 8px 24px rgba(249,115,22,0.4)', marginBottom: '20px' }}>B</div>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 10px', letterSpacing: '-0.5px' }}>{title}</h1>
        <p style={{ margin: '0 0 18px', color: '#cbd5e1', fontSize: '15px', lineHeight: 1.55 }}>{body}</p>
        {detail}
        {showReload && (
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: '20px', background: ORANGE, color: 'white', border: 'none', padding: '12px 26px', borderRadius: '10px', fontSize: '15px', cursor: 'pointer', fontWeight: 700, boxShadow: '0 6px 18px rgba(249,115,22,0.35)' }}
          >
            Reload
          </button>
        )}
      </div>
    </div>
  )
}

export function MissingConfigScreen({ missing }: { missing: EnvRequirement[] }) {
  return (
    <FullScreenNotice
      title="BuildPro+ isn't finished setting up"
      body="The app can't start because it was built without its configuration. If you're the owner, set the environment variables below and redeploy — everyone else, please check back shortly."
      detail={
        <div style={{ textAlign: 'left', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '16px 18px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '1px', textTransform: 'uppercase', color: ORANGE, fontWeight: 800, marginBottom: '10px' }}>Missing at build time</div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#e2e8f0', fontSize: '13px', lineHeight: 1.7 }}>
            {missing.map(m => (
              <li key={m.key}><code style={{ color: '#fdba74' }}>{m.key}</code> — {m.label}</li>
            ))}
          </ul>
        </div>
      }
    />
  )
}

// Catches render-time throws (e.g. an invalid Clerk key, or anything downstream)
// so a component crash shows a recoverable message instead of a blank page.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('App crashed:', error)
  }
  render() {
    if (this.state.error) {
      return (
        <FullScreenNotice
          title="Something went wrong"
          body="BuildPro+ hit an unexpected error while loading. Reloading usually clears it."
          showReload
        />
      )
    }
    return this.props.children
  }
}
