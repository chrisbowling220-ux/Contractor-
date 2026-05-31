import { useEffect, useState } from 'react'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { toCustomerView } from './lib/customerView'
import { BrandHeader, BrandFooter } from './lib/BrandHeader'
import type { Estimate } from './data/types'

// Renders a single estimate at /q/<id> for the customer to view without signing in.
// Markup is hidden via toCustomerView so the customer sees baked-in material prices.
// Customer can accept or decline; the response is written back to the same doc.
export default function PublicEstimate({ estimateId }: { estimateId: string }) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Response form state
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
        const snap = await getDoc(doc(db, 'estimates', estimateId))
        if (done) return
        if (!snap.exists()) {
          setError('This estimate could not be found. The link may be expired or incorrect.')
        } else {
          const data = { id: snap.id, ...snap.data() } as Estimate
          setEstimate(data)
          // Fetch the contractor's business profile so the header brands it.
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
            } catch { /* graceful fallback to BuildPro+ branding */ }
          }
          // Intentionally do NOT pre-fill the signature with the customer name —
          // the customer must type their own name to sign.
        }
      } catch (err) {
        if (done) return
        console.error('PublicEstimate load failed:', err)
        setError('Could not load the estimate. Please reload the page or contact your contractor.')
      } finally {
        done = true
        window.clearTimeout(fallbackTimer)
        setLoading(false)
      }
    })()
    return () => { done = true; window.clearTimeout(fallbackTimer) }
  }, [estimateId])

  const submitResponse = async (action: 'approved' | 'declined') => {
    if (!estimate) return
    if (!signedName.trim()) {
      setSubmitError('Please type your full name to sign.')
      return
    }
    if (action === 'declined' && !showDeclineBox) {
      // First click on Decline reveals the reason box rather than submitting.
      setShowDeclineBox(true)
      return
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      const customerResponse = {
        action,
        signedName: signedName.trim(),
        ...(action === 'declined' && declineReason.trim() ? { reason: declineReason.trim() } : {}),
        respondedAt: new Date().toISOString(),
      }
      await updateDoc(doc(db, 'estimates', estimate.id), {
        customerResponse,
        status: action,
      })
      setEstimate({ ...estimate, customerResponse, status: action })
    } catch (err) {
      setSubmitError('Could not submit your response. ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}>
        <p style={{ color: '#64748b' }}>Loading estimate…</p>
      </div>
    )
  }
  if (error || !estimate) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
        <div style={{ maxWidth: '460px', textAlign: 'center' }}>
          <h1 style={{ color: '#dc2626', fontSize: '20px', marginBottom: '12px' }}>Estimate Not Available</h1>
          <p style={{ color: '#64748b' }}>{error || 'Unknown error.'}</p>
        </div>
      </div>
    )
  }

  const ai = estimate.aiQuote ? toCustomerView(estimate.aiQuote) : undefined
  const response = estimate.customerResponse
  const responded = !!response

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <BrandHeader
          title="Estimate"
          subtitle={`${estimate.jobTypeName}${estimate.jobLocationZip ? ` · ZIP ${estimate.jobLocationZip}` : ''}${estimate.createdAt ? ` · ${new Date(estimate.createdAt).toLocaleDateString()}` : ''}`}
          businessName={businessName}
          logoUrl={logoUrl}
          businessPhone={businessPhone}
          businessEmail={businessEmail}
          licenseNumber={licenseNumber}
        />

        <div style={{ padding: '24px' }}>
          <p style={{ fontSize: '15px', marginTop: 0, marginBottom: '12px' }}>
            Hi <strong>{estimate.customerName}</strong>, here's your estimate.
          </p>

          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '10px 14px', marginBottom: '20px', fontSize: '13px', color: '#92400e', lineHeight: 1.5 }}>
            ⓘ This is a <strong>rough estimate</strong>, not a guaranteed price. Final cost may change based on actual site conditions, material prices, and any changes to the scope of work. Your contractor will confirm details before work begins.
          </div>

          {ai ? (
            <>
              <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Summary</h3>
              <p style={{ fontSize: '14px', lineHeight: 1.5, marginTop: 0, marginBottom: '20px' }}>{ai.customer_summary}</p>

              <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Work Scope</h3>
              <pre style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', whiteSpace: 'pre-wrap', margin: '0 0 20px' }}>{ai.work_scope}</pre>

              {ai.material_list.length > 0 && (
                <>
                  <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Materials</h3>
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
                        {ai.material_list.map((m, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px' }}>{m.name}</td>
                            <td style={{ padding: '8px', textAlign: 'right' }}>{m.quantity_with_waste} {m.unit}</td>
                            <td style={{ padding: '8px', textAlign: 'right' }}>${m.unit_price.toFixed(2)}</td>
                            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>${m.line_total.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Materials</span><span style={{ fontWeight: 600 }}>${ai.price_breakdown.materials_subtotal.toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Labor ({ai.labor.estimated_hours}h × ${ai.labor.hourly_rate}/hr)</span><span style={{ fontWeight: 600 }}>${ai.price_breakdown.labor_subtotal.toFixed(2)}</span></div>
                {ai.price_breakdown.rentals_subtotal > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Rentals</span><span style={{ fontWeight: 600 }}>${ai.price_breakdown.rentals_subtotal.toFixed(2)}</span></div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', marginTop: '8px', borderTop: '2px solid #f97316' }}>
                  <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Total</span>
                  <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${ai.final_customer_quote.toFixed(2)}</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <pre style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', whiteSpace: 'pre-wrap', marginBottom: '20px' }}>{estimate.scopeOfWork || ''}</pre>
              <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <span style={{ color: '#fb923c', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Total</span>
                <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${(estimate.total || 0).toFixed(2)}</span>
              </div>
            </>
          )}

          {/* Accept / Decline section */}
          {responded ? (
            response!.action === 'approved' ? (
              <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>✅</div>
                <h2 style={{ margin: '0 0 8px', color: '#16a34a', fontSize: '20px' }}>Estimate Accepted</h2>
                <p style={{ margin: '0 0 4px', fontSize: '14px', color: '#1a1f2e' }}>
                  Signed by <strong>{response!.signedName}</strong>
                </p>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
                  on {new Date(response!.respondedAt).toLocaleString()}
                </p>
                <p style={{ margin: '16px 0 0', fontSize: '14px', color: '#1a1f2e' }}>Your contractor has been notified and will be in touch to schedule the work.</p>
              </div>
            ) : (
              <div style={{ background: '#fef2f2', border: '2px solid #dc2626', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📝</div>
                <h2 style={{ margin: '0 0 8px', color: '#dc2626', fontSize: '20px' }}>Estimate Declined</h2>
                <p style={{ margin: '0 0 4px', fontSize: '14px', color: '#1a1f2e' }}>
                  Declined by <strong>{response!.signedName}</strong>
                </p>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
                  on {new Date(response!.respondedAt).toLocaleString()}
                </p>
                {response!.reason && (
                  <p style={{ margin: '12px 0 0', fontSize: '14px', color: '#1a1f2e', fontStyle: 'italic' }}>
                    "{response!.reason}"
                  </p>
                )}
                <p style={{ margin: '16px 0 0', fontSize: '13px', color: '#64748b' }}>If this was a mistake, contact your contractor directly.</p>
              </div>
            )
          ) : (
            <div style={{ background: '#fff7ed', border: '2px solid #f97316', borderRadius: '12px', padding: '20px' }}>
              <h3 style={{ margin: '0 0 6px', fontSize: '16px', color: '#1a1f2e' }}>Ready to move forward?</h3>
              <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#64748b' }}>
                Type your full name to sign, then choose Accept or Decline.
              </p>

              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                Your Signature (typed full name) *
              </label>
              <input
                value={signedName}
                onChange={e => setSignedName(e.target.value)}
                placeholder="Type your full name here"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '15px', fontFamily: 'cursive', marginBottom: '12px', boxSizing: 'border-box' }}
              />

              {showDeclineBox && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                    Reason for declining (optional)
                  </label>
                  <textarea
                    value={declineReason}
                    onChange={e => setDeclineReason(e.target.value)}
                    rows={3}
                    placeholder="Briefly tell your contractor why — pricing, timing, scope changes, etc."
                    style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
                  />
                </div>
              )}

              {submitError && <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#dc2626' }}>⚠ {submitError}</p>}

              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => submitResponse('approved')}
                  disabled={submitting}
                  style={{ flex: '1 1 200px', background: '#16a34a', color: 'white', border: 'none', padding: '14px 20px', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}
                >
                  ✅ Accept Estimate
                </button>
                <button
                  onClick={() => submitResponse('declined')}
                  disabled={submitting}
                  style={{ flex: '1 1 200px', background: showDeclineBox ? '#dc2626' : '#fef2f2', color: showDeclineBox ? 'white' : '#dc2626', border: '1px solid #dc2626', padding: '14px 20px', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}
                >
                  {showDeclineBox ? '❌ Confirm Decline' : '❌ Decline'}
                </button>
              </div>
              {showDeclineBox && (
                <button onClick={() => { setShowDeclineBox(false); setDeclineReason('') }} style={{ background: 'transparent', border: 'none', color: '#64748b', padding: '8px 0', marginTop: '8px', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline' }}>
                  Cancel — go back
                </button>
              )}
              <p style={{ margin: '14px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                By accepting, you authorize the contractor to begin the work described above at the quoted price. By declining, you let your contractor know this estimate isn't right for you.
              </p>
            </div>
          )}

          <p style={{ fontSize: '13px', color: '#64748b', margin: '20px 0 0', textAlign: 'center' }}>
            Questions? Reply to the message your contractor sent you, or contact them directly.
          </p>
        </div>
      </div>
      <BrandFooter />
    </div>
  )
}
