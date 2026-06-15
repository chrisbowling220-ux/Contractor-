import { useState, useEffect, useRef } from 'react'
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { signOut as firebaseSignOut } from 'firebase/auth'
import { db, storage, functions, firebaseAuth } from './firebase'
import { useUser, useAuth } from '@clerk/clerk-react'
import { notificationsBlocked, requestNotificationPermission, alertsEnabled, setAlertsEnabled, playAlertCue } from './lib/reminders'
import PayoutSetup from './PayoutSetup'

const FREE_TIER_AI_LIMIT = 10

const subscriptionCheckoutCallable = httpsCallable<{ clerkToken: string; email?: string; plan?: string }, { url: string }>(functions, 'createSubscriptionCheckout')
const portalSessionCallable = httpsCallable<{ clerkToken: string }, { url: string }>(functions, 'createPortalSession')
const connectStatusCallable = httpsCallable<{ clerkToken: string }, { connected: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>(functions, 'getConnectStatus')
const quotePackCallable = httpsCallable<{ clerkToken: string; email?: string; quantity: number }, { url: string }>(functions, 'createQuotePackCheckout')

const PLATFORM_FEE_PERCENT = 2

// Settings page — business profile stored on users/{userId} in Firestore.
// All fields are optional; the rest of the app gracefully falls back to
// BuildPro+ branding when fields are empty.
export default function Settings() {
  const { user } = useUser()
  const { getToken, signOut } = useAuth()
  const [tier, setTier] = useState<'free' | 'pro'>('free')
  const [aiQuotesUsed, setAiQuotesUsed] = useState(0)
  const [paidQuoteCredits, setPaidQuoteCredits] = useState(0)
  // Stripe's real paid-through date (epoch ms) + whether the sub is set to cancel.
  const [periodEnd, setPeriodEnd] = useState<number | null>(null)
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false)
  const [buyQty, setBuyQty] = useState(3)
  const [billingBusy, setBillingBusy] = useState(false)
  // Payout setup status (embedded onboarding).
  const [payoutsEnabled, setPayoutsEnabled] = useState(false)
  const [payoutsDetailsSubmitted, setPayoutsDetailsSubmitted] = useState(false)
  const [connectChecked, setConnectChecked] = useState(false)
  const [payoutModalOpen, setPayoutModalOpen] = useState(false)
  // Notification / alert preferences (mirror the dashboard toggle).
  const [notifyDenied, setNotifyDenied] = useState(notificationsBlocked())
  const [alertsOn, setAlertsOn] = useState(alertsEnabled())

  // Turn alerts on (sound+vibration work without permission) and best-effort
  // ask for pop-up permission. Never loops or scolds.
  const turnOnNotifications = async () => {
    setAlertsEnabled(true); setAlertsOn(true); playAlertCue()
    try { await requestNotificationPermission() } catch { /* ignore */ }
    setNotifyDenied(notificationsBlocked())
  }
  const toggleAlerts = () => {
    const next = !alertsOn
    setAlertsOn(next); setAlertsEnabled(next)
    if (next) playAlertCue()
  }
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoStoragePath, setLogoStoragePath] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [status, setStatus] = useState('')

  const logoCameraRef = useRef<HTMLInputElement>(null)
  const logoUploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!user?.id) return
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.id))
        if (snap.exists()) {
          const data = snap.data() as {
            businessName?: string
            businessPhone?: string
            businessEmail?: string
            licenseNumber?: string
            logoUrl?: string
            logoStoragePath?: string
            tier?: 'free' | 'pro'
            aiQuotesUsed?: number
          }
          setBusinessName(data.businessName || '')
          setBusinessPhone(data.businessPhone || '')
          setBusinessEmail(data.businessEmail || '')
          setLicenseNumber(data.licenseNumber || '')
          setLogoUrl(data.logoUrl || '')
          setLogoStoragePath(data.logoStoragePath || '')
          setTier(data.tier === 'pro' ? 'pro' : 'free')
          setAiQuotesUsed(data.aiQuotesUsed || 0)
        }
      } catch (err) {
        console.error('Settings load failed:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [user?.id])

  // Live subscription on tier + usage so the plan badge and remaining-quote
  // count update in real time (right after upgrading, or after using a quote)
  // without needing a page reload.
  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(doc(db, 'users', user.id), snap => {
      const data = snap.data() as { tier?: 'free' | 'pro'; aiQuotesUsed?: number; paidQuoteCredits?: number; subscriptionCurrentPeriodEnd?: number; cancelAtPeriodEnd?: boolean } | undefined
      if (!data) return
      setTier(data.tier === 'pro' ? 'pro' : 'free')
      setAiQuotesUsed(data.aiQuotesUsed || 0)
      setPaidQuoteCredits(Math.max(0, data.paidQuoteCredits || 0))
      setPeriodEnd(typeof data.subscriptionCurrentPeriodEnd === 'number' ? data.subscriptionCurrentPeriodEnd : null)
      setCancelAtPeriodEnd(!!data.cancelAtPeriodEnd)
    }, err => console.error('Settings tier listener failed:', err))
    return () => unsub()
  }, [user?.id])

  const save = async () => {
    if (!user?.id) { alert('Not signed in.'); return }
    setSaving(true)
    setStatus('')
    try {
      await setDoc(doc(db, 'users', user.id), {
        businessName: businessName.trim(),
        businessPhone: businessPhone.trim(),
        businessEmail: businessEmail.trim(),
        licenseNumber: licenseNumber.trim(),
        logoUrl: logoUrl || '',
        logoStoragePath: logoStoragePath || '',
        updatedAt: new Date().toISOString(),
      }, { merge: true })
      setStatus('✓ Saved')
      setTimeout(() => setStatus(''), 2500)
    } catch (err) {
      setStatus('⚠ ' + (err instanceof Error ? err.message : 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  // Upgrade to Pro → Stripe subscription Checkout.
  const upgradeToPro = async (plan: 'monthly' | 'quarterly' | 'yearly' = 'monthly') => {
    setBillingBusy(true)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const res = await subscriptionCheckoutCallable({ clerkToken, email: user?.primaryEmailAddress?.emailAddress, plan })
      if (res.data?.url) window.location.href = res.data.url
      else throw new Error('No checkout URL returned')
    } catch (err) {
      alert('Could not start upgrade: ' + (err instanceof Error ? err.message : String(err)))
      setBillingBusy(false)
    }
  }

  // ── Stripe Connect payouts ──
  // Check payout readiness on load (and after returning from onboarding).
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const clerkToken = await getToken()
        if (!clerkToken) return
        const res = await connectStatusCallable({ clerkToken })
        if (cancelled) return
        setPayoutsEnabled(!!res.data?.payoutsEnabled)
        setPayoutsDetailsSubmitted(!!res.data?.detailsSubmitted)
      } catch (err) {
        console.error('Payout status check failed:', err)
      } finally {
        if (!cancelled) setConnectChecked(true)
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, getToken])

  // Re-check payout readiness (e.g. right after the embedded onboarding closes).
  const refreshPayoutStatus = async () => {
    try {
      const clerkToken = await getToken()
      if (!clerkToken) return
      const res = await connectStatusCallable({ clerkToken })
      setPayoutsEnabled(!!res.data?.payoutsEnabled)
      setPayoutsDetailsSubmitted(!!res.data?.detailsSubmitted)
    } catch (err) {
      console.error('Payout status refresh failed:', err)
    }
  }

  // Pay-as-you-go: buy `buyQty` quote credits at $1 each.
  const buyQuotePack = async () => {
    setBillingBusy(true)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const res = await quotePackCallable({ clerkToken, email: user?.primaryEmailAddress?.emailAddress, quantity: buyQty })
      if (res.data?.url) window.location.href = res.data.url
      else throw new Error('No checkout URL returned')
    } catch (err) {
      alert('Could not start checkout: ' + (err instanceof Error ? err.message : String(err)))
      setBillingBusy(false)
    }
  }

  // Opens the embedded "Get Paid" setup (bank/identity form right in the app).
  const setupPayouts = () => setPayoutModalOpen(true)

  // Manage subscription → Stripe Customer Portal (cancel, update card, invoices).
  const manageSubscription = async () => {
    setBillingBusy(true)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const res = await portalSessionCallable({ clerkToken })
      if (res.data?.url) window.location.href = res.data.url
      else throw new Error('No portal URL returned')
    } catch (err) {
      alert('Could not open billing portal: ' + (err instanceof Error ? err.message : String(err)))
      setBillingBusy(false)
    }
  }

  const logOff = async () => {
    if (!confirm('Log off of BuildPro+?')) return
    try {
      // Tear down the Firebase session first, then the Clerk session. Once
      // Clerk signs out, the app's <SignedOut> automatically shows the sign-in
      // page. The hard reload guarantees a clean slate (no stale listeners).
      try { await firebaseSignOut(firebaseAuth) } catch { /* may already be signed out */ }
      await signOut()
      window.location.href = '/'
    } catch (err) {
      alert('Could not log off: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const uploadLogo = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user?.id) return
    const file = files[0]
    setUploadingLogo(true)
    setStatus('')
    try {
      // If there's an existing logo, delete it first.
      if (logoStoragePath) {
        try { await deleteObject(storageRef(storage, logoStoragePath)) } catch { /* old logo may already be gone */ }
      }
      const ts = Date.now()
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
      const path = `userLogos/${user.id}/${ts}-${safeName}`
      const sRef = storageRef(storage, path)
      await uploadBytes(sRef, file, { contentType: file.type })
      const url = await getDownloadURL(sRef)
      setLogoUrl(url)
      setLogoStoragePath(path)
      // Persist immediately so it shows everywhere without needing Save.
      await setDoc(doc(db, 'users', user.id), {
        logoUrl: url,
        logoStoragePath: path,
        updatedAt: new Date().toISOString(),
      }, { merge: true })
      setStatus('✓ Logo uploaded')
      setTimeout(() => setStatus(''), 2500)
    } catch (err) {
      setStatus('⚠ ' + (err instanceof Error ? err.message : 'Upload failed'))
    } finally {
      setUploadingLogo(false)
    }
  }

  const removeLogo = async () => {
    if (!user?.id || !logoStoragePath) return
    if (!confirm('Remove your logo? You can upload a new one anytime.')) return
    try {
      try { await deleteObject(storageRef(storage, logoStoragePath)) } catch { /* fine */ }
      await setDoc(doc(db, 'users', user.id), {
        logoUrl: '',
        logoStoragePath: '',
        updatedAt: new Date().toISOString(),
      }, { merge: true })
      setLogoUrl('')
      setLogoStoragePath('')
      setStatus('✓ Logo removed')
      setTimeout(() => setStatus(''), 2500)
    } catch (err) {
      setStatus('⚠ ' + (err instanceof Error ? err.message : 'Remove failed'))
    }
  }

  const input: React.CSSProperties = { padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '15px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }
  const card: React.CSSProperties = { background: 'white', padding: '24px', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', marginBottom: '16px' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '720px', margin: '0 auto' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: '#1a1f2e', letterSpacing: '-0.5px' }}>⚙️ Settings</h2>
        <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>Set your business profile. This is what customers see on letters, estimates, and share pages.</p>
      </div>

      {/* LOGO */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>🖼️ Business Logo</h3>
        <p style={{ margin: '0 0 16px', color: '#64748b', fontSize: '13px' }}>
          Optional. Replaces the orange "B" mark on customer-facing pages, letters, and printed estimates. Square images work best; PNG/JPG.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ width: '88px', height: '88px', background: logoUrl ? 'white' : '#f97316', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
            {logoUrl ? (
              <img src={logoUrl} alt="Logo preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <span style={{ color: 'white', fontWeight: 800, fontSize: '36px' }}>{(businessName.trim()[0] || 'B').toUpperCase()}</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button onClick={() => logoCameraRef.current?.click()} disabled={uploadingLogo} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: uploadingLogo ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
                📷 Take Photo
              </button>
              <button onClick={() => logoUploadRef.current?.click()} disabled={uploadingLogo} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: uploadingLogo ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
                {logoUrl ? 'Replace' : 'Upload Image'}
              </button>
              {logoUrl && (
                <button onClick={removeLogo} style={{ background: 'transparent', color: '#dc2626', border: '1px solid #fecaca', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                  🗑️ Remove
                </button>
              )}
              <input ref={logoCameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => { uploadLogo(e.target.files); e.target.value = '' }} />
              <input ref={logoUploadRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { uploadLogo(e.target.files); e.target.value = '' }} />
            </div>
            {uploadingLogo && <p style={{ fontSize: '13px', color: '#7c3aed', margin: 0 }}>Uploading…</p>}
          </div>
        </div>
      </div>

      {/* BUSINESS PROFILE */}
      <div style={card}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>🏢 Business Profile</h3>

        <div style={{ marginBottom: '16px' }}>
          <label style={label}>Business Name</label>
          <input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="e.g. Bowling Construction LLC" style={input} disabled={loading} />
          <p style={{ fontSize: '12px', color: '#94a3b8', margin: '6px 0 0' }}>
            Customers see <strong>{businessName.trim() || 'your business name'}</strong> on letters and estimates.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginBottom: '16px' }}>
          <div>
            <label style={label}>Business Phone</label>
            <input type="tel" value={businessPhone} onChange={e => setBusinessPhone(e.target.value)} placeholder="(555) 555-5555" style={input} disabled={loading} />
          </div>
          <div>
            <label style={label}>Business Email</label>
            <input type="email" value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} placeholder="you@yourbusiness.com" style={input} disabled={loading} />
          </div>
        </div>

        <div>
          <label style={label}>License Number (optional)</label>
          <input value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} placeholder="NC General Contractor #123456" style={input} disabled={loading} />
          <p style={{ fontSize: '12px', color: '#94a3b8', margin: '6px 0 0' }}>Shown on customer-facing estimates and letters for credibility.</p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '20px' }}>
          <button
            onClick={save}
            disabled={saving || loading}
            style={{ background: saving || loading ? '#cbd5e1' : '#f97316', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: saving || loading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}
          >
            {saving ? 'Saving…' : '💾 Save'}
          </button>
          {status && <span style={{ fontSize: '13px', color: status.startsWith('✓') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{status}</span>}
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>💎 Subscription</h3>
        {tier === 'pro' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '4px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' }}>BuildPro+ Pro</span>
              <span style={{ fontSize: '13px', color: '#64748b' }}>Unlimited quotes + thank-you letters · $19.99/mo</span>
            </div>
            {periodEnd && (
              <p style={{ fontSize: '13px', color: cancelAtPeriodEnd ? '#b45309' : '#16a34a', fontWeight: 600, margin: '0 0 12px' }}>
                {cancelAtPeriodEnd
                  ? `⚠ Set to cancel — your Pro access ends ${new Date(periodEnd).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.`
                  : `✓ Pro access through ${new Date(periodEnd).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} — renews automatically.`}
              </p>
            )}
            <button onClick={manageSubscription} disabled={billingBusy} style={{ background: billingBusy ? '#cbd5e1' : '#1a1f2e', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: billingBusy ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
              {billingBusy ? 'Opening…' : 'Manage subscription'}
            </button>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '10px', marginBottom: 0 }}>Cancel, update your card, or view invoices in Stripe's secure portal. If you cancel, you keep Pro until the end of the billing period.</p>
          </>
        ) : (
          <>
            <p style={{ fontSize: '14px', color: '#1a1f2e', marginTop: 0, marginBottom: '8px' }}>
              You're on the <strong>Free</strong> plan — <strong>{Math.max(0, FREE_TIER_AI_LIMIT - aiQuotesUsed) + paidQuoteCredits} instant quotes left</strong>
              {paidQuoteCredits > 0 && <span style={{ color: '#16a34a' }}> ({paidQuoteCredits} paid)</span>}. Only instant Quick Quotes count toward the limit.
            </p>
            <ul style={{ fontSize: '13px', color: '#475569', margin: '0 0 16px', paddingLeft: '20px', lineHeight: 1.7 }}>
              <li><strong>Free forever:</strong> change orders, invoices & manual estimates — unlimited</li>
              <li><strong>Pro:</strong> unlimited instant quotes</li>
              <li><strong>Pro:</strong> 🎁 customer thank-you letters with job photos</li>
              <li>Cancel anytime</li>
            </ul>
            {/* Three plans: monthly, 3 months up front, or yearly all-access. */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button onClick={() => upgradeToPro('monthly')} disabled={billingBusy} style={{ background: billingBusy ? '#cbd5e1' : '#f97316', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: billingBusy ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}>
                {billingBusy ? 'Starting…' : '⚡ Pro — $19.99/mo'}
              </button>
              <button onClick={() => upgradeToPro('quarterly')} disabled={billingBusy} style={{ background: 'white', color: '#f97316', border: '2px solid #f97316', padding: '12px 24px', borderRadius: '8px', cursor: billingBusy ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
                💰 3 months — $49.99 <span style={{ fontSize: '11px', color: '#16a34a', fontWeight: 700 }}>(save ~17%)</span>
              </button>
              <button onClick={() => upgradeToPro('yearly')} disabled={billingBusy} style={{ background: billingBusy ? '#cbd5e1' : '#16a34a', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: billingBusy ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(22,163,74,0.25)' }}>
                🏆 Yearly — all access $159.99/yr <span style={{ fontSize: '11px', color: '#dcfce7', fontWeight: 700 }}>(best value · save ~33%)</span>
              </button>
            </div>

            {/* Pay-as-you-go — don't want a subscription? Buy quotes at $1 each. */}
            <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: '1px dashed #e2e8f0' }}>
              <p style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 700, color: '#1a1f2e' }}>Don't want a subscription?</p>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#64748b' }}>
                Buy instant quotes <strong>$1 each</strong> — pick how many. They never expire, and you only pay for what you use.
              </p>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={buyQty} onChange={e => setBuyQty(Number(e.target.value))} style={{ padding: '11px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '15px', fontWeight: 600 }}>
                  {Array.from({ length: 10 }, (_, n) => n + 1).map(n => (
                    <option key={n} value={n}>{n} quote{n === 1 ? '' : 's'}</option>
                  ))}
                </select>
                <button onClick={buyQuotePack} disabled={billingBusy} style={{ background: billingBusy ? '#cbd5e1' : '#1a1f2e', color: 'white', border: 'none', padding: '12px 22px', borderRadius: '8px', cursor: billingBusy ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
                  {billingBusy ? 'Starting…' : `Buy for $${buyQty}.00`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Get Paid: embedded card-payout setup ── */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>💳 Get Paid — Card Payments</h3>
        {!connectChecked ? (
          <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>Checking your payout setup…</p>
        ) : payoutsEnabled ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '4px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700 }}>✓ Payouts active</span>
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              Your customers can pay invoices by card, and the money goes straight to your bank (usually in ~2 business days). A small <strong>{PLATFORM_FEE_PERCENT}% fee</strong> comes off each card payment — that keeps your Quick Quote AI and all the other generators running, so the app pays for itself.
            </p>
            <button onClick={setupPayouts} style={{ marginTop: '12px', background: '#f1f5f9', color: '#1a1f2e', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
              Update payout details
            </button>
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 10px', fontSize: '14px', color: '#1a1f2e' }}>
              Let customers <strong>pay you by card</strong> right from the invoice — money lands in your own bank account.
            </p>
            <ul style={{ fontSize: '13px', color: '#475569', margin: '0 0 14px', paddingLeft: '20px', lineHeight: 1.7 }}>
              <li>Quick one-time setup — add your bank or debit card (~2 minutes), right here in the app</li>
              <li>Customers pay by card; you get paid directly</li>
              <li>A small <strong>{PLATFORM_FEE_PERCENT}% fee</strong> per card payment keeps your AI quotes & generators running — the app pays for itself</li>
              <li>Don't want card payments? You can always just use cash, Venmo, or Zelle instead.</li>
            </ul>
            <button onClick={setupPayouts} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(22,163,74,0.25)' }}>
              {payoutsDetailsSubmitted ? '⏳ Finish payout setup' : '💳 Set up card payouts'}
            </button>
          </>
        )}
      </div>

      {/* Embedded payout setup modal — renders the bank/identity form in-app. */}
      {payoutModalOpen && (
        <PayoutSetup
          onClose={() => setPayoutModalOpen(false)}
          onDone={() => { setPayoutModalOpen(false); refreshPayoutStatus() }}
        />
      )}

      {/* ── Notifications & alerts ── */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>🔔 Notifications &amp; Alerts</h3>
        <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#64748b' }}>
          Get reminded about jobs, payments, and anything that needs attention. When alerts are on, your phone gets a sound and a buzz (where supported) as new reminders come in.
        </p>
        {/* Always-available ON/OFF. Sound + vibration don't need browser
            permission; turning on also quietly requests pop-up permission. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {!alertsOn ? (
            <button onClick={turnOnNotifications} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
              🔕 Alerts OFF — tap to turn on
            </button>
          ) : (
            <button onClick={toggleAlerts} title="Alerts on — sound & vibration. Tap to turn OFF." style={{ background: '#16a34a', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
              🔔 Alerts ON — tap to turn off
            </button>
          )}
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>{alertsOn ? 'Sound & vibration on new reminders.' : 'Muted — no sound, buzz, or pop-ups.'}</span>
        </div>
        {alertsOn && notifyDenied && (
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#b45309' }}>
            Note: pop-up banners are blocked in your browser, but in-app sound &amp; vibration still work. To also get banner pop-ups, allow notifications for this site (tap the 🔒 in the address bar → Notifications → Allow).
          </p>
        )}
      </div>

      {/* Account / Log off */}
      <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>👤 Account</h3>
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            Signed in as {user?.primaryEmailAddress?.emailAddress || user?.firstName || 'you'}.
          </p>
        </div>
        <button onClick={logOff} style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
          🔒 Log Off
        </button>
      </div>

      {/* Legal links — always reachable. */}
      <p style={{ textAlign: 'center', fontSize: '12px', color: '#94a3b8', marginTop: '8px' }}>
        <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#64748b', textDecoration: 'underline' }}>Terms of Service</a>
        {' · '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#64748b', textDecoration: 'underline' }}>Privacy Policy</a>
      </p>
    </div>
  )
}

export interface BusinessProfile {
  businessName: string
  businessPhone: string
  businessEmail: string
  licenseNumber: string
  logoUrl: string
}

// Fetcher used by other parts of the app (BrandHeader, print, thank-you, etc.)
// Always returns a populated object — empty strings for missing fields.
export async function fetchBusinessProfile(userId: string): Promise<BusinessProfile> {
  const empty: BusinessProfile = { businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '' }
  if (!userId) return empty
  try {
    const snap = await getDoc(doc(db, 'users', userId))
    if (!snap.exists()) return empty
    const d = snap.data() as Partial<BusinessProfile>
    return {
      businessName: d.businessName || '',
      businessPhone: d.businessPhone || '',
      businessEmail: d.businessEmail || '',
      licenseNumber: d.licenseNumber || '',
      logoUrl: d.logoUrl || '',
    }
  } catch {
    return empty
  }
}

// Back-compat shim for existing callers.
export async function fetchBusinessName(userId: string): Promise<string> {
  const p = await fetchBusinessProfile(userId)
  return p.businessName
}
