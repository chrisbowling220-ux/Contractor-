import { useEffect, useState } from 'react'
import { useAuth, useUser } from '@clerk/clerk-react'
import { httpsCallable } from 'firebase/functions'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import { ConnectComponentsProvider, ConnectAccountOnboarding } from '@stripe/react-connect-js'
import { functions } from './firebase'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

const accountSessionCallable = httpsCallable<{ clerkToken: string; email?: string }, { clientSecret: string }>(functions, 'createConnectAccountSession')

// Embedded "Get Paid" setup — renders the bank/identity form INSIDE the app
// (no redirect to a separate site). On finish, calls onDone so Settings can
// refresh the payout-active status. We never say "Stripe" in the copy.
export default function PayoutSetup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user } = useUser()
  const { getToken } = useAuth()
  const [instance, setInstance] = useState<StripeConnectInstance | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
        if (!pk) throw new Error('Payment setup is temporarily unavailable. Please try again later.')
        const connect = loadConnectAndInitialize({
          publishableKey: pk,
          fetchClientSecret: async () => {
            const clerkToken = await getToken()
            if (!clerkToken) throw new Error('Not signed in')
            const res = await accountSessionCallable({ clerkToken, email: user?.primaryEmailAddress?.emailAddress })
            if (!res.data?.clientSecret) throw new Error('Could not start setup')
            return res.data.clientSecret
          },
          appearance: {
            variables: {
              colorPrimary: ORANGE,
              colorText: NAVY,
              borderRadius: '8px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            },
          },
        })
        if (!cancelled) { setInstance(connect); setLoading(false) }
      } catch (err) {
        if (!cancelled) {
          // Most likely cause if it fails at init: Connect not enabled on the
          // platform account. Keep the message friendly + actionable for the owner.
          const msg = err instanceof Error ? err.message : 'Could not start payout setup.'
          setError(msg.includes('connect') || msg.includes('Connect')
            ? 'Card payouts aren\'t switched on for this account yet. (Owner: enable Connect in your payments dashboard, then try again.)'
            : msg)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [getToken, user?.primaryEmailAddress?.emailAddress])

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 500, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', margin: '24px auto', background: 'white', borderRadius: '16px', overflow: 'hidden' }}>
        <div style={{ background: NAVY, color: 'white', padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '17px', color: ORANGE }}>💳 Get Paid — Quick Setup</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '24px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '18px' }}>
          <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#64748b' }}>
            Add your bank or debit card so customers can pay you by card and the money lands in your account. Takes about 2 minutes. Your info is handled securely and never stored in the app.
          </p>

          {loading && <p style={{ textAlign: 'center', color: '#94a3b8', padding: '30px 0' }}>Loading secure setup…</p>}

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px 14px', fontSize: '13px' }}>
              {error}
            </div>
          )}

          {instance && !error && (
            <ConnectComponentsProvider connectInstance={instance}>
              <ConnectAccountOnboarding
                onExit={() => { onDone(); onClose() }}
              />
            </ConnectComponentsProvider>
          )}
        </div>
      </div>
    </div>
  )
}
