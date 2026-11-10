import { useState } from 'react'
import { deleteField, doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { Invoice, PaymentMethod } from './data/types'
import { PAYMENT_METHOD_LABEL, balanceOf, localDateStr, recordPayment, removePayment } from './lib/invoiceMath'
import { PUBLIC_HOST } from './lib/config'

interface Props {
  // Pass the LIVE invoice (from the Projects listener) so the history and the
  // balance refresh the moment a payment is saved.
  invoice: Invoice
  onClose: () => void
  // Called once when a payment brings the balance to zero.
  onPaidInFull?: (invoice: Invoice) => void | Promise<void>
}

const METHODS: PaymentMethod[] = ['cash', 'check', 'zelle', 'venmo', 'bank_transfer', 'other']

// Record money the contractor has ALREADY received (cash, check, Zelle…) and
// see everything paid on an invoice so far. This is a ledger: nothing here
// charges a card or moves money. Card payments come in through the customer's
// pay link and are added to this history automatically.
export default function RecordPaymentModal({ invoice, onClose, onPaidInFull }: Props) {
  const due = balanceOf(invoice.subtotal, invoice.amountPaid || 0)
  const paid = invoice.status === 'paid' || due <= 0
  const [amount, setAmount] = useState(due > 0 ? due.toFixed(2) : '')
  const [method, setMethod] = useState<PaymentMethod>(invoice.customerCashChoice ? 'cash' : 'check')
  const [date, setDate] = useState(localDateStr())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const payments = invoice.payments || []
  // Money counted against the invoice that isn't an itemised payment: a deposit
  // credited when the invoice was built.
  const credit = Math.max(0, +((invoice.amountPaid || 0) - payments.reduce((s, p) => s + p.amount, 0)).toFixed(2))
  // A card payment taken before payments were itemised has no entry of its own.
  const legacyCard = invoice.status === 'paid' ? Math.max(0, +(invoice.subtotal - (invoice.amountPaid || 0)).toFixed(2)) : 0

  const save = async () => {
    setError(''); setSaved('')
    let update
    try {
      update = recordPayment(invoice, { amount: Number(amount), method, date, note })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the payment details.')
      return
    }
    setBusy(true)
    try {
      await updateDoc(doc(db, 'invoices', invoice.id), { ...update })
      const paidOff = update.status === 'paid'
      setSaved(paidOff
        ? `✓ Saved — invoice ${invoice.invoiceNumber} is paid in full.`
        : `✓ Saved — $${update.amountDue.toFixed(2)} still owed.`)
      setAmount(paidOff ? '' : update.amountDue.toFixed(2))
      setNote('')
      if (paidOff && onPaidInFull) {
        try { await onPaidInFull({ ...invoice, ...update }) } catch (err) { console.error('After-payment step failed:', err) }
      }
    } catch (err) {
      setError('Could not save the payment: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const undo = async (paymentId: string, label: string) => {
    if (!confirm(`Remove the ${label} payment from this invoice? Use this for a typo or a bounced check.`)) return
    setError(''); setSaved('')
    setBusy(true)
    try {
      const { reopened, ...update } = removePayment(invoice, paymentId)
      await updateDoc(doc(db, 'invoices', invoice.id), {
        ...update,
        // A re-opened invoice is no longer a paid record.
        ...(reopened ? { paidAt: deleteField(), paidAtMs: deleteField() } : {}),
      })
      setAmount(update.amountDue.toFixed(2))
      setSaved(reopened ? '✓ Removed — the invoice is open again.' : '✓ Payment removed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that payment.')
    } finally {
      setBusy(false)
    }
  }

  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 700, color: '#475569', marginBottom: '4px' }
  // 16px inputs: anything smaller makes iOS Safari zoom the page on focus.
  const field: React.CSSProperties = { width: '100%', padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '16px', fontFamily: 'inherit', boxSizing: 'border-box', background: 'white' }
  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #f1f5f9', fontSize: '14px' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <h2 id="pay-title" style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>Payments — {invoice.invoiceNumber}</h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>{invoice.customerName}</p>
          </div>
          <button onClick={onClose} aria-label="Close payments" style={{ background: 'transparent', color: 'white', border: '1px solid #475569', borderRadius: '8px', minWidth: '44px', minHeight: '44px', fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '14px' }}>
            {[
              { k: 'Invoice total', v: invoice.subtotal, c: '#1a1f2e' },
              { k: 'Received', v: paid ? invoice.subtotal : (invoice.amountPaid || 0), c: '#16a34a' },
              { k: 'Still owed', v: paid ? 0 : due, c: paid ? '#16a34a' : '#ea580c' },
            ].map(t => (
              <div key={t.k} style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 6px', textAlign: 'center' }}>
                <div style={{ fontSize: '11px', color: '#64748b' }}>{t.k}</div>
                <div style={{ fontSize: '17px', fontWeight: 700, color: t.c }}>${t.v.toFixed(2)}</div>
              </div>
            ))}
          </div>

          {!paid && (
            <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', marginBottom: '14px' }}>
              <h3 style={{ margin: '0 0 4px', fontSize: '15px' }}>Record a payment you received</h3>
              <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#64748b' }}>
                For cash, checks, Zelle and the like. This only updates your records — it does not charge the customer.
                {invoice.customerCashChoice ? ' This customer said they would pay in person.' : ''}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div>
                  <label style={label} htmlFor="pay-amount">Amount ($)</label>
                  <input id="pay-amount" type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} style={field} />
                </div>
                <div>
                  <label style={label} htmlFor="pay-date">Date received</label>
                  <input id="pay-date" type="date" value={date} max={localDateStr()} onChange={e => setDate(e.target.value)} style={field} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={label} htmlFor="pay-method">How they paid</label>
                  <select id="pay-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} style={field}>
                    {METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={label} htmlFor="pay-note">Note (optional)</label>
                  <input id="pay-note" value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="Check #1042" style={field} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={save} disabled={busy} style={{ flex: '1 1 160px', background: busy ? '#94a3b8' : '#16a34a', color: 'white', border: 'none', padding: '14px', borderRadius: '8px', cursor: busy ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
                  {busy ? 'Saving…' : 'Save payment'}
                </button>
                {Number(amount) !== due && (
                  <button onClick={() => setAmount(due.toFixed(2))} disabled={busy} style={{ background: 'white', border: '1px solid #cbd5e1', padding: '14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '14px' }}>
                    Full balance (${due.toFixed(2)})
                  </button>
                )}
              </div>
            </div>
          )}

          <div role="status" aria-live="polite">
            {saved && <p style={{ margin: '0 0 12px', padding: '10px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', color: '#15803d', fontWeight: 600, fontSize: '14px' }}>{saved}</p>}
          </div>
          {error && <p role="alert" style={{ margin: '0 0 12px', padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#b91c1c', fontWeight: 600, fontSize: '14px' }}>{error}</p>}

          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '4px 14px 8px', marginBottom: '14px' }}>
            <h3 style={{ margin: '10px 0 2px', fontSize: '15px' }}>Payment history</h3>
            {credit === 0 && payments.length === 0 && legacyCard === 0 && (
              <p style={{ margin: '8px 0', fontSize: '13px', color: '#94a3b8' }}>Nothing received on this invoice yet.</p>
            )}
            {credit > 0 && (
              <div style={row}>
                <span><strong>Deposit / earlier payment credited</strong><br /><span style={{ color: '#64748b', fontSize: '12px' }}>Applied when this invoice was created</span></span>
                <strong style={{ color: '#16a34a' }}>${credit.toFixed(2)}</strong>
              </div>
            )}
            {payments.map(p => (
              <div key={p.id} style={row}>
                <span style={{ minWidth: 0 }}>
                  <strong>{PAYMENT_METHOD_LABEL[p.method] || p.method}</strong> · {new Date(p.date + 'T12:00:00').toLocaleDateString()}
                  {p.note && <><br /><span style={{ color: '#64748b', fontSize: '12px', wordBreak: 'break-word' }}>{p.note}</span></>}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '0 0 auto' }}>
                  <strong style={{ color: '#16a34a' }}>${p.amount.toFixed(2)}</strong>
                  {p.source !== 'stripe' && (
                    <button onClick={() => undo(p.id, `$${p.amount.toFixed(2)} ${PAYMENT_METHOD_LABEL[p.method] || ''}`.trim())} disabled={busy} aria-label={`Remove the $${p.amount.toFixed(2)} payment`} style={{ background: 'transparent', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Remove</button>
                  )}
                </span>
              </div>
            ))}
            {legacyCard > 0 && (
              <div style={row}>
                <span><strong>Paid online by card</strong>{invoice.paidAt ? ` · ${new Date(invoice.paidAt).toLocaleDateString()}` : ''}</span>
                <strong style={{ color: '#16a34a' }}>${legacyCard.toFixed(2)}</strong>
              </div>
            )}
          </div>

          <a href={`${PUBLIC_HOST}/inv/${invoice.id}?print=1`} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textAlign: 'center', background: '#1a1f2e', color: 'white', padding: '13px', borderRadius: '8px', fontWeight: 700, fontSize: '14px', textDecoration: 'none', marginBottom: '8px' }}>
            🖨️ Print {paid ? 'receipt' : 'statement'} (or save as PDF)
          </a>
          <button onClick={onClose} style={{ width: '100%', background: 'transparent', border: '1px solid #e2e8f0', padding: '12px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>Done</button>
        </div>
      </div>
    </div>
  )
}
