import { useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { Invoice } from './data/types'
import { PUBLIC_HOST } from './lib/config'

interface Props {
  invoice: Invoice
  // Regenerate the cover note + payment terms (optionally with instructions).
  onRegenerate: (subtotal: number, amountPaid: number, paymentMethods: string) => Promise<{ introNote: string; paymentTerms: string }>
  // Called with the saved invoice when the user is done — opens the share modal.
  onDone: (updated: Invoice) => void
  onClose: () => void
}

// Edit an invoice's cover note, payment terms, amount already paid, and due
// date. Line items stay rolled up from the estimate + approved change orders
// (the source of truth) — only the wording and payment fields are editable.
export default function InvoiceEditModal({ invoice, onRegenerate, onDone, onClose }: Props) {
  const [introNote, setIntroNote] = useState(invoice.introNote)
  const [paymentTerms, setPaymentTerms] = useState(invoice.paymentTerms)
  const [amountPaid, setAmountPaid] = useState(String(invoice.amountPaid || 0))
  const [paymentMethods, setPaymentMethods] = useState('')
  // Due date as yyyy-mm-dd for the date input.
  const [dueDate, setDueDate] = useState(invoice.dueDate ? invoice.dueDate.slice(0, 10) : '')
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [savedNote, setSavedNote] = useState('')

  const paidNum = Math.max(0, Number(amountPaid) || 0)
  const amountDue = +(invoice.subtotal - paidNum).toFixed(2)

  const buildUpdates = () => ({
    introNote,
    paymentTerms,
    amountPaid: paidNum,
    amountDue,
    dueDate: dueDate ? new Date(dueDate + 'T12:00:00').toISOString() : invoice.dueDate,
  })

  const save = async (): Promise<Invoice> => {
    const updates = buildUpdates()
    await updateDoc(doc(db, 'invoices', invoice.id), updates)
    return { ...invoice, ...updates }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await save()
      setSavedNote('✓ Saved')
      setTimeout(() => setSavedNote(''), 2000)
    } catch (err) {
      setSavedNote('⚠ ' + (err instanceof Error ? err.message : 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      const { introNote: nextIntro, paymentTerms: nextTerms } = await onRegenerate(invoice.subtotal, paidNum, paymentMethods.trim())
      setIntroNote(nextIntro)
      setPaymentTerms(nextTerms)
    } catch (err) {
      alert('Could not regenerate: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setRegenerating(false)
    }
  }

  const handleDone = async () => {
    setSaving(true)
    try {
      const updated = await save()
      onDone(updated)
    } catch (err) {
      alert('Save failed: ' + (err instanceof Error ? err.message : String(err)))
      setSaving(false)
    }
  }

  // Save current edits, open the branded customer invoice in a new tab/window,
  // auto-trigger print there, and close back to Projects. Reuses the same
  // public invoice layout the customer sees, so the printed PDF is consistent.
  const handlePrint = async () => {
    setSaving(true)
    try {
      await save()
      const url = `${PUBLIC_HOST}/inv/${invoice.id}?print=1`
      window.open(url, '_blank', 'noopener,noreferrer')
      onClose()
    } catch (err) {
      alert('Could not open print view: ' + (err instanceof Error ? err.message : String(err)))
      setSaving(false)
    }
  }

  const fieldLabel: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }
  const field: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '640px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Sticky header — back button is always reachable, even after scrolling */}
        <div style={{ background: '#1a1f2e', color: 'white', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
          <button onClick={onClose} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>
            ← Back to Project
          </button>
          <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>🧾 Edit Invoice {invoice.invoiceNumber}</h2>
          <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>Edit the wording & payment details. Line items come from the estimate.</p>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Totals summary (read-only) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Subtotal</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>${invoice.subtotal.toFixed(2)}</div>
            </div>
            <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Paid</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#16a34a' }}>${paidNum.toFixed(2)}</div>
            </div>
            <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#64748b' }}>Due</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#f97316' }}>${amountDue.toFixed(2)}</div>
            </div>
          </div>

          {/* Editable fields */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
            <label style={fieldLabel}>Cover note</label>
            <textarea value={introNote} onChange={e => setIntroNote(e.target.value)} rows={3} style={{ ...field, marginBottom: '12px' }} />
            <label style={fieldLabel}>Payment terms</label>
            <textarea value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)} rows={3} style={{ ...field, marginBottom: '12px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={fieldLabel}>Amount already paid ($)</label>
                <input type="number" value={amountPaid} onChange={e => setAmountPaid(e.target.value)} style={field} placeholder="0" />
              </div>
              <div>
                <label style={fieldLabel}>Due date</label>
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={field} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
              <button onClick={handleSave} disabled={saving} style={{ background: saving ? '#cbd5e1' : '#1a1f2e', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
                {saving ? 'Saving…' : '💾 Save edits'}
              </button>
              {savedNote && <span style={{ fontSize: '13px', color: savedNote.startsWith('✓') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{savedNote}</span>}
            </div>
          </div>

          {/* Regenerate wording */}
          <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
            <label style={fieldLabel}>Regenerate wording — accepted payment methods (optional)</label>
            <input
              value={paymentMethods}
              onChange={e => setPaymentMethods(e.target.value)}
              placeholder="e.g. Check, Venmo, Zelle, cash, or card"
              style={{ ...field, marginBottom: '10px' }}
            />
            <button onClick={handleRegenerate} disabled={regenerating} style={{ background: regenerating ? '#cbd5e1' : '#7c3aed', color: 'white', border: 'none', padding: '9px 16px', borderRadius: '6px', cursor: regenerating ? 'default' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
              {regenerating ? '✨ Rewriting…' : '✨ Regenerate cover note & terms'}
            </button>
          </div>

          <button onClick={handleDone} disabled={saving} style={{ width: '100%', background: saving ? '#cbd5e1' : '#16a34a', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
            Save & Continue to Send →
          </button>
          <button onClick={handlePrint} disabled={saving} style={{ width: '100%', marginTop: '8px', background: '#1a1f2e', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
            🖨️ Print or Save as PDF
          </button>
          <button onClick={onClose} style={{ width: '100%', marginTop: '8px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
