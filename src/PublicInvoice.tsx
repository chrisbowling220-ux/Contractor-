import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'
import { BrandHeader, BrandFooter } from './lib/BrandHeader'
import type { Invoice } from './data/types'

// Public invoice viewer at /inv/<id>. No sign-in required.
// onRequest function endpoint (not a callable — the paying customer is not
// signed in, so we use a plain HTTP POST and verify the amount server-side).
const CHECKOUT_URL = 'https://us-central1-contractors-office-96731.cloudfunctions.net/createInvoiceCheckout'

export default function PublicInvoice({ invoiceId }: { invoiceId: string }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState('')

  async function payByCard() {
    setPaying(true)
    setPayError('')
    try {
      const resp = await fetch(CHECKOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || !data.url) {
        throw new Error(data.error || 'Could not start checkout.')
      }
      window.location.href = data.url
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Could not start checkout. Please try again.')
      setPaying(false)
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'invoices', invoiceId))
        if (!snap.exists()) setError('This invoice could not be found.')
        else setInvoice({ id: snap.id, ...snap.data() } as Invoice)
      } catch {
        setError('Could not load. Please contact your contractor.')
      } finally { setLoading(false) }
    })()
  }, [invoiceId])

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}><p style={{ color: '#64748b' }}>Loading…</p></div>
  }
  if (error || !invoice) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
        <div style={{ maxWidth: '460px', textAlign: 'center' }}>
          <h1 style={{ color: '#dc2626', fontSize: '20px', marginBottom: '12px' }}>Invoice Not Found</h1>
          <p style={{ color: '#64748b' }}>{error || 'Unknown error.'}</p>
        </div>
      </div>
    )
  }

  const due = new Date(invoice.dueDate)
  const overdue = invoice.status !== 'paid' && due.getTime() < Date.now()

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <BrandHeader
          title={`Invoice ${invoice.invoiceNumber}`}
          subtitle={`${invoice.jobTypeName} · ${new Date(invoice.createdAt).toLocaleDateString()}`}
          businessName={invoice.businessName}
          logoUrl={invoice.logoUrl}
          businessPhone={invoice.businessPhone}
          businessEmail={invoice.businessEmail}
          licenseNumber={invoice.licenseNumber}
        />

        <div style={{ padding: '24px' }}>
          {/* Status badge */}
          {invoice.status === 'paid' && (
            <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px', textAlign: 'center' }}>
              <strong style={{ color: '#16a34a', fontSize: '15px' }}>✓ Paid</strong>
              {invoice.paidAt && <span style={{ color: '#64748b', fontSize: '13px', marginLeft: '8px' }}>· {new Date(invoice.paidAt).toLocaleDateString()}</span>}
            </div>
          )}
          {overdue && (
            <div style={{ background: '#fef2f2', border: '2px solid #dc2626', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px', textAlign: 'center' }}>
              <strong style={{ color: '#dc2626', fontSize: '15px' }}>⚠ Past Due</strong>
              <span style={{ color: '#64748b', fontSize: '13px', marginLeft: '8px' }}>· Due {due.toLocaleDateString()}</span>
            </div>
          )}

          <p style={{ fontSize: '15px', marginTop: 0, marginBottom: '20px' }}>
            Hi <strong>{invoice.customerName}</strong>,
          </p>
          <p style={{ fontSize: '14px', lineHeight: 1.6, color: '#1a1f2e', marginBottom: '24px' }}>{invoice.introNote}</p>

          {/* Bill-to + Date block */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px', padding: '16px', background: '#f8fafc', borderRadius: '8px' }}>
            <div>
              <h4 style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 4px' }}>Bill to</h4>
              <p style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{invoice.customerName}</p>
              {invoice.customerAddress && <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#64748b' }}>{invoice.customerAddress}</p>}
              {invoice.customerEmail && <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#64748b' }}>{invoice.customerEmail}</p>}
              {invoice.customerPhone && <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#64748b' }}>{invoice.customerPhone}</p>}
            </div>
            <div>
              <h4 style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 4px' }}>Invoice Date</h4>
              <p style={{ margin: 0, fontSize: '14px' }}>{new Date(invoice.createdAt).toLocaleDateString()}</p>
              <h4 style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '12px 0 4px' }}>Due Date</h4>
              <p style={{ margin: 0, fontSize: '14px', color: overdue ? '#dc2626' : '#1a1f2e', fontWeight: overdue ? 700 : 400 }}>{due.toLocaleDateString()}</p>
            </div>
          </div>

          {/* Line items */}
          <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 8px' }}>Line Items</h3>
          <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
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
                {invoice.lineItems.map((li, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px' }}>{li.name}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{li.quantity}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>${li.unitPrice.toFixed(2)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>${li.lineTotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}>
              <span style={{ color: '#cbd5e1' }}>Subtotal</span>
              <span style={{ fontWeight: 600 }}>${invoice.subtotal.toFixed(2)}</span>
            </div>
            {invoice.amountPaid > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '14px' }}>
                <span style={{ color: '#cbd5e1' }}>Deposit / payments received</span>
                <span style={{ fontWeight: 600, color: '#86efac' }}>− ${invoice.amountPaid.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', marginTop: '8px', borderTop: '2px solid #f97316' }}>
              <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Amount Due</span>
              <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${invoice.amountDue.toFixed(2)}</span>
            </div>
          </div>

          {/* Payment terms */}
          <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px', margin: '0 0 6px' }}>Payment Terms</h3>
          <p style={{ fontSize: '14px', lineHeight: 1.6, color: '#1a1f2e', marginTop: 0, marginBottom: '24px' }}>{invoice.paymentTerms}</p>

          {invoice.status !== 'paid' && invoice.amountDue > 0 && (
            <>
              <button onClick={payByCard} disabled={paying} style={{ width: '100%', background: paying ? '#94a3b8' : '#16a34a', color: 'white', border: 'none', padding: '14px', borderRadius: '8px', cursor: paying ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px', marginBottom: '12px' }}>
                {paying ? 'Redirecting to secure checkout…' : `💳 Pay $${invoice.amountDue.toFixed(2)} by Card`}
              </button>
              {payError && <p style={{ color: '#dc2626', fontSize: '13px', textAlign: 'center', marginTop: 0, marginBottom: '12px' }}>{payError}</p>}
              <p style={{ fontSize: '11px', color: '#94a3b8', textAlign: 'center', margin: '0 0 16px' }}>Secure payment powered by Stripe. Your card details never touch this site.</p>
            </>
          )}

          <button onClick={() => window.print()} style={{ width: '100%', background: '#1a1f2e', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
            🖨️ Print or Save as PDF
          </button>
        </div>
      </div>
      <BrandFooter />

      <style>{`
        @media print {
          body { background: white; }
          button { display: none !important; }
        }
      `}</style>
    </div>
  )
}
