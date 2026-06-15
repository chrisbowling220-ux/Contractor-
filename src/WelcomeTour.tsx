import { useState } from 'react'
import { SignUpButton } from '@clerk/clerk-react'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

// The order mirrors how a contractor actually uses the app on a real job:
// quote it → get it signed → take a deposit → run the job → get paid → win the
// next one. Each slide is one step of that loop.
const STEPS: { icon: string; eyebrow: string; title: React.ReactNode; body: string; points?: string[] }[] = [
  {
    icon: '👋',
    eyebrow: 'Welcome to BuildPro+',
    title: <>Get your nights <span style={{ color: ORANGE }}>back.</span></>,
    body: 'A quick look at how BuildPro+ turns a walkthrough into a signed, paid job — all from your phone, on the job site. No manual needed.',
    points: ['Quote on site in seconds', 'Customer signs before you leave', 'Every job tracked in one place'],
  },
  {
    icon: '⚡',
    eyebrow: 'Step 1 · Quick Quote',
    title: <>Quote a job in <span style={{ color: ORANGE }}>30 seconds.</span></>,
    body: 'Take a photo of the job and talk through it like you\'re telling a helper what to do. BuildPro+ builds a full material list, prices it for your area, and figures the labor — you just tweak and send.',
    points: ['Full material list with prices', 'Priced for your ZIP code', 'Every line editable before it goes out'],
  },
  {
    icon: '✍️',
    eyebrow: 'Step 2 · Customer Sign-Off',
    title: <>Get it signed <span style={{ color: ORANGE }}>on the spot.</span></>,
    body: 'Text the quote or hand them your phone. The customer sees a clean, branded page and signs right there. The second they sign, you get an alert — no more chasing people down.',
    points: ['Signs on their own phone', 'You\'re notified instantly', 'No paper, no waiting'],
  },
  {
    icon: '💵',
    eyebrow: 'Step 3 · Deposits & Pay',
    title: <>Get paid <span style={{ color: ORANGE }}>before you start.</span></>,
    body: 'Ask for a deposit right in the quote. When they approve, they can pay by card on the spot — or pay the whole job up front. The money goes straight to your account through Stripe.',
    points: ['Customer pays by card instantly', 'Or pays cash — your call', 'Secure payments through Stripe'],
  },
  {
    icon: '🗂️',
    eyebrow: 'Step 4 · The job runs itself',
    title: <>Track it without <span style={{ color: ORANGE }}>lifting a finger.</span></>,
    body: 'Once they say yes, the job moves itself: Lead → In Progress → Done → Closed. Photos, change orders, and the invoice all live in one place. Add jobs by voice and get a 6am heads-up every morning.',
    points: ['Change orders in 30 seconds', 'One-tap branded invoices', 'Voice calendar + morning reminders'],
  },
  {
    icon: '🚀',
    eyebrow: 'You\'re ready',
    title: <>Let\'s land your <span style={{ color: ORANGE }}>first job.</span></>,
    body: 'That\'s the whole loop — quote it, sign it, get paid. Create your free account and run your next bid through it. First 10 quotes are on us, no card needed.',
  },
]

// Shown when a brand-new visitor taps "Sign Up" on the landing page. Walks them
// through the real features in the best order, then drops them into the actual
// Clerk sign-up flow so they can create their account. Existing users who tap
// "Sign In" never see this.
export default function WelcomeTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const step = STEPS[i]
  const isLast = i === STEPS.length - 1

  const go = (next: number) => {
    setLeaving(true)
    setTimeout(() => { setI(next); setLeaving(false) }, 160)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: `linear-gradient(135deg, ${NAVY} 0%, #0f172a 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', overflowY: 'auto' }}>
      <div style={{ width: '560px', maxWidth: '94vw', background: 'white', borderRadius: '22px', overflow: 'hidden', boxShadow: '0 30px 80px rgba(15,23,42,0.22)', margin: '24px auto' }}>
        {/* progress bar */}
        <div style={{ height: '4px', background: '#f1f5f9' }}>
          <div style={{ height: '100%', background: ORANGE, width: `${((i + 1) / STEPS.length) * 100}%`, transition: 'width 0.45s cubic-bezier(.2,.8,.2,1)' }} />
        </div>

        <div style={{ padding: '36px 38px 28px', transition: 'opacity 0.16s', opacity: leaving ? 0 : 1 }}>
          <div style={{ width: '60px', height: '60px', borderRadius: '16px', background: '#fff7ed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px', marginBottom: '20px' }}>{step.icon}</div>
          <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: ORANGE, marginBottom: '8px' }}>{step.eyebrow}</div>
          <h2 style={{ margin: 0, fontSize: '34px', lineHeight: 1.05, fontWeight: 800, color: NAVY, letterSpacing: '-0.5px' }}>{step.title}</h2>
          <p style={{ margin: '14px 0 0', fontSize: '16px', lineHeight: 1.55, color: '#64748b' }}>{step.body}</p>

          {step.points && (
            <div style={{ marginTop: '22px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {step.points.map(p => (
                <div key={p} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: '#fff7ed', border: `1px solid ${ORANGE}`, color: ORANGE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flex: '0 0 auto', fontSize: '14px' }}>✓</span>
                  <span style={{ fontSize: '15px', color: NAVY }}>{p}</span>
                </div>
              ))}
            </div>
          )}

          {/* On the final (signup) slide, show the agreement notice. */}
          {isLast && (
            <p style={{ marginTop: '20px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
              By creating an account, you agree to our{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: ORANGE, textDecoration: 'underline' }}>Terms of Service</a>{' '}and{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: ORANGE, textDecoration: 'underline' }}>Privacy Policy</a>.
            </p>
          )}
        </div>

        {/* footer controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 38px 28px', borderTop: '1px solid #f1f5f9' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {STEPS.map((_, idx) => (
              <span key={idx} style={{ height: '9px', width: idx === i ? '26px' : '9px', borderRadius: '5px', background: idx === i ? ORANGE : '#e2e8f0', transition: 'all 0.3s' }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {!isLast && (
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '14px', fontWeight: 500, cursor: 'pointer', padding: '10px' }}>Skip</button>
            )}
            {isLast ? (
              <SignUpButton mode="modal">
                <button onClick={onClose} style={{ background: ORANGE, color: 'white', border: 'none', fontWeight: 700, fontSize: '15px', padding: '13px 26px', borderRadius: '11px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(249,115,22,0.3)' }}>
                  Create my free account →
                </button>
              </SignUpButton>
            ) : (
              <button onClick={() => go(i + 1)} style={{ background: ORANGE, color: 'white', border: 'none', fontWeight: 700, fontSize: '15px', padding: '13px 26px', borderRadius: '11px', cursor: 'pointer' }}>
                Next →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
