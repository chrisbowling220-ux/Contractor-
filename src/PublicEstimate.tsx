import { useEffect, useState } from 'react'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { toCustomerView } from './lib/customerView'
import { BrandHeader, BrandFooter } from './lib/BrandHeader'
import { FUNCTIONS_BASE_URL } from './lib/config'
import type { Estimate } from './data/types'

const DEPOSIT_INVOICE_URL = `${FUNCTIONS_BASE_URL}/createDepositInvoiceForApproval`

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
  // Deposit-payment state (after approval, when a deposit was requested).
  const [preparingDeposit, setPreparingDeposit] = useState(false)
  const [depositInvoiceId, setDepositInvoiceId] = useState<string | null>(null)
  // Start-date confirmation state.
  const [showDateChange, setShowDateChange] = useState(false)
  const [requestedDate, setRequestedDate] = useState('')
  const [dateNote, setDateNote] = useState('')
  const [dateSubmitting, setDateSubmitting] = useState(false)

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
      const now = new Date()
      const customerResponse = {
        action,
        signedName: signedName.trim(),
        ...(action === 'declined' && declineReason.trim() ? { reason: declineReason.trim() } : {}),
        respondedAt: now.toISOString(),
      }
      await updateDoc(doc(db, 'estimates', estimate.id), {
        customerResponse,
        status: action,
        // Epoch-ms anchor for the 2-year retention lock (numeric so security
        // rules can compare it). Only meaningful when approved (signed).
        ...(action === 'approved' ? { signedAtMs: now.getTime() } : {}),
      })
      setEstimate({ ...estimate, customerResponse, status: action })

      // If they APPROVED an estimate with a deposit, prepare the deposit invoice
      // server-side so they can pay it right now (card or cash).
      if (action === 'approved' && estimate.depositRequested && (estimate.depositAmount || 0) > 0) {
        setPreparingDeposit(true)
        try {
          const resp = await fetch(DEPOSIT_INVOICE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estimateId: estimate.id }),
          })
          const data = await resp.json().catch(() => ({}))
          if (resp.ok && data.invoiceId) setDepositInvoiceId(data.invoiceId)
        } catch (err) {
          console.warn('Deposit invoice prep failed:', err)
        } finally {
          setPreparingDeposit(false)
        }
      }
    } catch (err) {
      setSubmitError('Could not submit your response. ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  // Customer confirms the proposed start date, or requests a different one.
  const submitDateResponse = async (action: 'confirmed' | 'requested_change') => {
    if (!estimate) return
    if (action === 'requested_change' && !showDateChange) {
      setShowDateChange(true)  // first tap reveals the date picker
      return
    }
    if (action === 'requested_change' && !requestedDate) {
      setSubmitError('Pick the date you\'d prefer to start.')
      return
    }
    setDateSubmitting(true)
    setSubmitError('')
    try {
      const startDateResponse = {
        action,
        ...(action === 'requested_change' && requestedDate ? { requestedDate } : {}),
        ...(dateNote.trim() ? { note: dateNote.trim() } : {}),
        respondedAt: new Date().toISOString(),
      }
      await updateDoc(doc(db, 'estimates', estimate.id), { startDateResponse })
      setEstimate({ ...estimate, startDateResponse })
    } catch (err) {
      setSubmitError('Could not submit. ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDateSubmitting(false)
    }
  }

  // Customer chose to pay the FULL job upfront instead of just the deposit.
  // Re-create the invoice at the full amount (server-verified) and go pay it.
  const payFullInstead = async () => {
    if (!estimate) return
    setPreparingDeposit(true)
    try {
      const resp = await fetch(DEPOSIT_INVOICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: estimate.id, payFull: true }),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.ok && data.invoiceId) {
        window.location.href = `/inv/${data.invoiceId}`
      } else {
        setSubmitError(data.error || 'Could not prepare the full-payment invoice.')
      }
    } catch {
      setSubmitError('Could not prepare the full-payment invoice. Please try again.')
    } finally {
      setPreparingDeposit(false)
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
      <div style={{ maxWidth: '720px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', overflow: 'hidden' }}>
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
            Hi <strong>{estimate.customerName}</strong>, here's your proposal.
          </p>

          {/* Professional proposal letter — the first thing the customer reads,
              framing the estimate below. Only shown when one was generated. */}
          {estimate.proposal && (
            <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px 22px', marginBottom: '20px', lineHeight: 1.6, fontSize: '14px', color: '#1a1f2e' }}>
              <p style={{ margin: '0 0 12px', fontWeight: 600 }}>{estimate.proposal.greeting}</p>
              <p style={{ margin: '0 0 14px' }}>{estimate.proposal.intro}</p>

              <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#1d4ed8', letterSpacing: '1px', margin: '0 0 4px' }}>Our Approach</h4>
              <p style={{ margin: '0 0 14px' }}>{estimate.proposal.approach}</p>

              <div style={{ whiteSpace: 'pre-wrap', margin: '0 0 14px' }}>{estimate.proposal.included}</div>
              <div style={{ whiteSpace: 'pre-wrap', margin: '0 0 14px', color: '#475569' }}>{estimate.proposal.not_included}</div>

              <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#1d4ed8', letterSpacing: '1px', margin: '0 0 4px' }}>Timeline</h4>
              <p style={{ margin: '0 0 14px' }}>{estimate.proposal.timeline}</p>

              <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#1d4ed8', letterSpacing: '1px', margin: '0 0 4px' }}>Our Guarantee</h4>
              <p style={{ margin: '0 0 14px' }}>{estimate.proposal.warranty}</p>

              <div style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontWeight: 600 }}>{estimate.proposal.closing}</div>
            </div>
          )}

          {estimate.proposal && (
            <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 10px' }}>
              The Work &amp; Your Investment
            </h3>
          )}

          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '10px 14px', marginBottom: '20px', fontSize: '13px', color: '#92400e', lineHeight: 1.5 }}>
            ⓘ This is a price <strong>estimate</strong>, not a guaranteed final price. The final cost may change based on actual site conditions or any changes to the scope of work. Your contractor will confirm details before work begins.
          </div>

          {/* Work scope/summary — what they're getting. We deliberately do NOT
              show the itemized materials list or unit prices to the customer
              (that detail, including markup, stays internal). They see the
              proposal above + a clean investment summary below. The full
              estimate is still stored intact for the contractor's records. */}
          {ai ? (
            <>
              <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Summary</h3>
              <p style={{ fontSize: '14px', lineHeight: 1.5, marginTop: 0, marginBottom: '20px' }}>{ai.customer_summary}</p>

              <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Work Scope</h3>
              <pre style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', whiteSpace: 'pre-wrap', margin: '0 0 20px' }}>{ai.work_scope}</pre>
            </>
          ) : (
            <pre style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', whiteSpace: 'pre-wrap', marginBottom: '20px' }}>{estimate.scopeOfWork || ''}</pre>
          )}

          {/* Clean investment summary — bottom line only (total, deposit,
              balance). No line items, no markup detail. */}
          {(() => {
            const total = ai ? ai.final_customer_quote : (estimate.total || 0)
            const deposit = estimate.depositRequested ? (estimate.depositAmount || 0) : 0
            const balance = Math.max(0, total - deposit)
            return (
              <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: deposit > 0 ? '12px' : 0, marginBottom: deposit > 0 ? '12px' : 0, borderBottom: deposit > 0 ? '2px solid #f97316' : 'none' }}>
                  <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>{deposit > 0 ? 'Total Investment' : 'Total'}</span>
                  <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${total.toFixed(2)}</span>
                </div>
                {deposit > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Deposit due to start</span><span style={{ fontWeight: 600 }}>${deposit.toFixed(2)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Balance at completion</span><span style={{ fontWeight: 600 }}>${balance.toFixed(2)}</span></div>
                  </>
                )}
              </div>
            )
          })()}

          {/* Proposed start date — customer confirms or requests a different day */}
          {estimate.proposedStartDate && (
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
              <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#1e40af', fontWeight: 700 }}>
                📅 Proposed start date: {new Date(estimate.proposedStartDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
              {estimate.startDateResponse ? (
                <p style={{ margin: 0, fontSize: '13px', color: '#1a1f2e' }}>
                  {estimate.startDateResponse.action === 'confirmed'
                    ? '✅ You confirmed this start date. Your contractor has been notified.'
                    : `📩 You requested ${estimate.startDateResponse.requestedDate ? new Date(estimate.startDateResponse.requestedDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : 'a different date'} instead. Your contractor will follow up.`}
                </p>
              ) : (
                <>
                  <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#64748b' }}>Does this work for you? Confirm it, or suggest a day that fits your schedule better.</p>
                  {showDateChange && (
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Your preferred start date</label>
                      <input type="date" value={requestedDate} onChange={e => setRequestedDate(e.target.value)} min={new Date().toISOString().slice(0, 10)} style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '15px', marginBottom: '8px', boxSizing: 'border-box' }} />
                      <textarea value={dateNote} onChange={e => setDateNote(e.target.value)} rows={2} placeholder="Any note for your contractor (optional)" style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button onClick={() => submitDateResponse('confirmed')} disabled={dateSubmitting} style={{ flex: '1 1 160px', background: '#16a34a', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: dateSubmitting ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
                      ✅ This date works
                    </button>
                    <button onClick={() => submitDateResponse('requested_change')} disabled={dateSubmitting} style={{ flex: '1 1 160px', background: showDateChange ? '#1a1f2e' : 'white', color: showDateChange ? 'white' : '#1a1f2e', border: '1px solid #cbd5e1', padding: '12px', borderRadius: '8px', cursor: dateSubmitting ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
                      {showDateChange ? '📩 Send my date' : '📅 Request a different day'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Accept / Decline section */}
          {responded ? (
            response!.action === 'approved' ? (
              <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>✅</div>
                <h2 style={{ margin: '0 0 8px', color: '#16a34a', fontSize: '20px' }}>Proposal Accepted</h2>
                <p style={{ margin: '0 0 4px', fontSize: '14px', color: '#1a1f2e' }}>
                  Signed by <strong>{response!.signedName}</strong>
                </p>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
                  on {new Date(response!.respondedAt).toLocaleString()}
                </p>
                <p style={{ margin: '16px 0 0', fontSize: '14px', color: '#1a1f2e' }}>Your contractor has been notified and will be in touch to schedule the work.</p>

                {/* Deposit payment — pay now (card), pay the full job, or cash */}
                {estimate.depositRequested && (estimate.depositAmount || 0) > 0 && (
                  <div style={{ marginTop: '20px', borderTop: '1px solid #bbf7d0', paddingTop: '16px' }}>
                    {preparingDeposit ? (
                      <p style={{ fontSize: '14px', color: '#16a34a', fontWeight: 600 }}>Preparing your deposit invoice…</p>
                    ) : depositInvoiceId ? (
                      <>
                        <p style={{ fontSize: '13px', color: '#1a1f2e', margin: '0 0 12px', fontWeight: 600 }}>Ready to get started? Choose how you'd like to pay:</p>
                        <a href={`/inv/${depositInvoiceId}`} style={{ display: 'block', background: '#16a34a', color: 'white', padding: '14px', borderRadius: '8px', fontWeight: 700, fontSize: '15px', textDecoration: 'none', marginBottom: '10px' }}>
                          💳 Pay Deposit ${(estimate.depositAmount || 0).toFixed(2)} Now
                        </a>
                        <button onClick={payFullInstead} disabled={preparingDeposit} style={{ display: 'block', width: '100%', background: '#1a1f2e', color: 'white', padding: '14px', borderRadius: '8px', fontWeight: 700, fontSize: '15px', border: 'none', cursor: 'pointer', marginBottom: '10px' }}>
                          💰 Pay Full ${(estimate.total || 0).toFixed(2)} Now Instead
                        </button>
                        <p style={{ fontSize: '12px', color: '#64748b', margin: 0 }}>Prefer to pay cash? No problem — just arrange it with your contractor. Work begins once the deposit is settled.</p>
                      </>
                    ) : (
                      <p style={{ fontSize: '13px', color: '#64748b' }}>Your contractor will send a deposit invoice shortly so you can pay by card or cash.</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ background: '#fef2f2', border: '2px solid #dc2626', borderRadius: '12px', padding: '20px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📝</div>
                <h2 style={{ margin: '0 0 8px', color: '#dc2626', fontSize: '20px' }}>Proposal Declined</h2>
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
              {estimate.depositRequested && (estimate.depositAmount || 0) > 0 && (
                <div style={{ background: 'white', border: '1px solid #fcd34d', borderRadius: '8px', padding: '12px 14px', marginBottom: '14px', fontSize: '13px', color: '#1a1f2e', lineHeight: 1.6 }}>
                  💵 <strong>A deposit of ${(estimate.depositAmount || 0).toFixed(2)}</strong> is requested to schedule and begin the work. The remaining <strong>${Math.max(0, (estimate.total || 0) - (estimate.depositAmount || 0)).toFixed(2)}</strong> is due when the job is complete. After you accept, you'll receive an invoice for the deposit.
                </div>
              )}
              <h3 style={{ margin: '0 0 6px', fontSize: '16px', color: '#1a1f2e' }}>Ready to move forward?</h3>
              <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#64748b' }}>
                Type your full name to sign, then choose Accept or Decline.
              </p>

              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                Your Signature (typed full name) — consent to terms *
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
                  ✅ Accept Proposal
                </button>
                <button
                  onClick={() => submitResponse('declined')}
                  disabled={submitting}
                  style={{ flex: '1 1 200px', background: showDeclineBox ? '#dc2626' : '#fef2f2', color: showDeclineBox ? 'white' : '#dc2626', border: '1px solid #dc2626', padding: '14px 20px', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}
                >
                  {showDeclineBox ? '❌ Confirm Decline' : '❌ Decline'}
                </button>
              </div>
              <p style={{ margin: '12px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 }}>
                By typing your name and tapping Accept, you electronically sign this proposal and agree to its scope and pricing
                {estimate.depositRequested && (estimate.depositAmount || 0) > 0
                  ? `, including the payment terms — a deposit of $${(estimate.depositAmount || 0).toFixed(2)} due upfront and the balance of $${Math.max(0, (estimate.total || 0) - (estimate.depositAmount || 0)).toFixed(2)} due at completion.`
                  : '.'}
              </p>
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
