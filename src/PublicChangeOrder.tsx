import { useEffect, useState } from 'react'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { ChangeOrder } from './data/types'
import { CHANGE_ORDER_REASON_LABEL } from './data/types'
import { BrandHeader, BrandFooter } from './lib/BrandHeader'

export default function PublicChangeOrder({ changeOrderId }: { changeOrderId: string }) {
  const [co, setCo] = useState<ChangeOrder | null>(null)
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [signedName, setSignedName] = useState('')
  const [declineReason, setDeclineReason] = useState('')
  const [showDeclineBox, setShowDeclineBox] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    let done = false
    const fallbackTimer = window.setTimeout(() => {
      if (done) return
      setError('Taking longer than expected. Check your connection and reload, or ask your contractor to resend.')
      setLoading(false)
    }, 15000)
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, 'changeOrders', changeOrderId))
        if (done) return
        if (!snap.exists()) {
          setError('This change order could not be found. The link may be expired or incorrect.')
        } else {
          const data = { id: snap.id, ...snap.data() } as ChangeOrder
          setCo(data)
          if (data.createdBy) {
            try {
              const userSnap = await getDoc(doc(db, 'users', data.createdBy))
              if (userSnap.exists()) {
                const u = userSnap.data() as { businessName?: string; businessPhone?: string; businessEmail?: string; licenseNumber?: string; logoUrl?: string }
                if (u.businessName?.trim()) setBusinessName(u.businessName.trim())
                if (u.businessPhone?.trim()) setBusinessPhone(u.businessPhone.trim())
                if (u.businessEmail?.trim()) setBusinessEmail(u.businessEmail.trim())
                if (u.licenseNumber?.trim()) setLicenseNumber(u.licenseNumber.trim())
                if (u.logoUrl?.trim()) setLogoUrl(u.logoUrl.trim())
              }
            } catch { /* graceful fallback */ }
          }
          // Intentionally do NOT pre-fill the signature with the customer name —
          // the customer must type their own name to sign.
        }
      } catch (err) {
        if (done) return
        console.error('PublicChangeOrder load failed:', err)
        setError('Could not load. Please reload the page or contact your contractor.')
      } finally {
        done = true
        window.clearTimeout(fallbackTimer)
        setLoading(false)
      }
    })()
    return () => { done = true; window.clearTimeout(fallbackTimer) }
  }, [changeOrderId])

  const submitResponse = async (action: 'approved' | 'declined') => {
    if (!co) return
    if (!signedName.trim()) { setSubmitError('Please type your full name to sign.'); return }
    if (action === 'declined' && !showDeclineBox) { setShowDeclineBox(true); return }
    setSubmitting(true); setSubmitError('')
    try {
      const now = new Date()
      const customerResponse = {
        action,
        signedName: signedName.trim(),
        ...(action === 'declined' && declineReason.trim() ? { reason: declineReason.trim() } : {}),
        respondedAt: now.toISOString(),
      }
      await updateDoc(doc(db, 'changeOrders', co.id), {
        customerResponse, status: action,
        // Epoch-ms anchor for the 2-year retention lock (numeric for rules).
        ...(action === 'approved' ? { signedAtMs: now.getTime() } : {}),
      })
      setCo({ ...co, customerResponse, status: action })
    } catch (err) {
      setSubmitError('Could not submit. ' + (err instanceof Error ? err.message : String(err)))
    } finally { setSubmitting(false) }
  }

  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}><p style={{ color: '#64748b' }}>Loading…</p></div>
  if (error || !co) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
      <div style={{ maxWidth: '460px', textAlign: 'center' }}>
        <h1 style={{ color: '#dc2626', fontSize: '20px', marginBottom: '12px' }}>Not Available</h1>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    </div>
  )

  const response = co.customerResponse
  const responded = !!response

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', overflow: 'hidden' }}>
        <BrandHeader
          title="Change Order"
          subtitle={`For ${co.customerName} · ${CHANGE_ORDER_REASON_LABEL[co.reason]} · ${new Date(co.createdAt).toLocaleDateString()}`}
          businessName={businessName}
          logoUrl={logoUrl}
          businessPhone={businessPhone}
          businessEmail={businessEmail}
          licenseNumber={licenseNumber}
        />

        <div style={{ padding: '24px' }}>
          <p style={{ fontSize: '15px', marginTop: 0, marginBottom: '20px' }}>
            Hi <strong>{co.customerName}</strong>, this is a change order for your project. Please review and respond below.
          </p>

          <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>What changed</h3>
          <p style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', fontSize: '14px', margin: '0 0 20px', lineHeight: 1.5 }}>{co.description}</p>

          {co.lineItems.length > 0 && (
            <>
              <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Itemized changes</h3>
              <div style={{ overflowX: 'auto', marginBottom: '20px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                      <th style={{ padding: '8px' }}>Item</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Unit $</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {co.lineItems.map((l, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px' }}>{l.name}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{l.quantity}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>${l.unitPrice.toFixed(2)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600, color: l.lineTotal < 0 ? '#16a34a' : '#1a1f2e' }}>{l.lineTotal < 0 ? '−' : ''}${Math.abs(l.lineTotal).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Previous total</span><span style={{ fontWeight: 600 }}>${co.originalTotal.toFixed(2)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}>
              <span style={{ color: '#cbd5e1' }}>Change {co.delta >= 0 ? '+' : '−'}</span>
              <span style={{ fontWeight: 700, color: co.delta >= 0 ? '#fb923c' : '#86efac' }}>{co.delta >= 0 ? '+' : '−'}${Math.abs(co.delta).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', marginTop: '8px', borderTop: '2px solid #f97316' }}>
              <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>New project total</span>
              <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${co.newTotal.toFixed(2)}</span>
            </div>
          </div>

          {responded ? (
            response!.action === 'approved' ? (
              <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>✅</div>
                <h2 style={{ margin: '0 0 8px', color: '#16a34a', fontSize: '20px' }}>Change Order Approved</h2>
                <p style={{ margin: '0 0 4px', fontSize: '14px' }}>Signed by <strong>{response!.signedName}</strong></p>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>on {new Date(response!.respondedAt).toLocaleString()}</p>
              </div>
            ) : (
              <div style={{ background: '#fef2f2', border: '2px solid #dc2626', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📝</div>
                <h2 style={{ margin: '0 0 8px', color: '#dc2626', fontSize: '20px' }}>Change Order Declined</h2>
                <p style={{ margin: '0 0 4px', fontSize: '14px' }}>Declined by <strong>{response!.signedName}</strong></p>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>on {new Date(response!.respondedAt).toLocaleString()}</p>
                {response!.reason && <p style={{ margin: '12px 0 0', fontSize: '14px', fontStyle: 'italic' }}>"{response!.reason}"</p>}
              </div>
            )
          ) : (
            <div style={{ background: '#fff7ed', border: '2px solid #f97316', borderRadius: '12px', padding: '20px' }}>
              <h3 style={{ margin: '0 0 6px', fontSize: '16px' }}>Approve this change?</h3>
              <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#64748b' }}>Type your full name to sign, then choose Accept or Decline.</p>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Your Signature (typed full name) *</label>
              <input value={signedName} onChange={e => setSignedName(e.target.value)} placeholder="Type your full name" style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '15px', fontFamily: 'cursive', marginBottom: '12px', boxSizing: 'border-box' }} />
              {showDeclineBox && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Reason for declining (optional)</label>
                  <textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} rows={3} placeholder="Briefly tell your contractor why." style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                </div>
              )}
              {submitError && <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#dc2626' }}>⚠ {submitError}</p>}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button onClick={() => submitResponse('approved')} disabled={submitting} style={{ flex: '1 1 200px', background: '#16a34a', color: 'white', border: 'none', padding: '14px 20px', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>✅ Accept Change</button>
                <button onClick={() => submitResponse('declined')} disabled={submitting} style={{ flex: '1 1 200px', background: showDeclineBox ? '#dc2626' : '#fef2f2', color: showDeclineBox ? 'white' : '#dc2626', border: '1px solid #dc2626', padding: '14px 20px', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>{showDeclineBox ? '❌ Confirm Decline' : '❌ Decline'}</button>
              </div>
              {showDeclineBox && <button onClick={() => { setShowDeclineBox(false); setDeclineReason('') }} style={{ background: 'transparent', border: 'none', color: '#64748b', padding: '8px 0', marginTop: '8px', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline' }}>Cancel — go back</button>}
            </div>
          )}
        </div>
      </div>
      <BrandFooter />
    </div>
  )
}
