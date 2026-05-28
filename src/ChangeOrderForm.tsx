import { useState, useMemo } from 'react'
import { db, functions } from './firebase'
import { addDoc, collection, doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useAuth, useUser } from '@clerk/clerk-react'
import type { ChangeOrder, ChangeOrderLine } from './data/types'
import { CHANGE_ORDER_REASON_LABEL } from './data/types'

interface Props {
  projectId: string
  customerName: string
  jobTypeName?: string
  jobLocationZip?: string
  originalTotal: number
  existing?: ChangeOrder | null
  onClose: () => void
  onSaved: (co: ChangeOrder) => void
}

interface AiChangeOrderResponse {
  description: string
  reason: ChangeOrder['reason']
  line_items: { name: string; quantity: number; unit_price: number; line_total: number }[]
  contractor_notes: string
}

const generateChangeOrderCallable = httpsCallable<
  {
    clerkToken: string
    input: {
      customerName: string
      jobTypeName: string
      jobLocationZip?: string
      originalTotal: number
      description: string
      hourlyRateOverride?: number
    }
  },
  AiChangeOrderResponse
>(functions, 'generateChangeOrder')

const REASONS: ChangeOrder['reason'][] = ['customer_requested', 'site_condition', 'code_requirement', 'other']

export default function ChangeOrderForm({ projectId, customerName, jobTypeName, jobLocationZip, originalTotal, existing, onClose, onSaved }: Props) {
  const { user } = useUser()
  const { getToken } = useAuth()
  const [description, setDescription] = useState(existing?.description || '')
  const [reason, setReason] = useState<ChangeOrder['reason']>(existing?.reason || 'customer_requested')
  const [lineItems, setLineItems] = useState<ChangeOrderLine[]>(
    existing?.lineItems?.length ? existing.lineItems : [{ name: '', quantity: 1, unitPrice: 0, lineTotal: 0 }]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // AI-generation flow state.
  // Default to AI mode for new change orders, manual for edits (since existing
  // ones already have data).
  const [mode, setMode] = useState<'ai' | 'manual'>(existing ? 'manual' : 'ai')
  const [aiDescription, setAiDescription] = useState('')
  const [aiHourlyRate, setAiHourlyRate] = useState('65')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiLoadingMessage, setAiLoadingMessage] = useState('')

  const runAI = async () => {
    if (!aiDescription.trim()) { setError('Describe what changed first.'); return }
    setError('')
    setAiLoading(true)
    setAiLoadingMessage('Generating change order…')
    const timers: number[] = []
    timers.push(window.setTimeout(() => setAiLoadingMessage('Still working — pricing the change…'), 8000))
    timers.push(window.setTimeout(() => setAiLoadingMessage('Almost there — retrying behind the scenes…'), 15000))
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const res = await generateChangeOrderCallable({
        clerkToken,
        input: {
          customerName,
          jobTypeName: jobTypeName || 'Project',
          jobLocationZip,
          originalTotal,
          description: aiDescription.trim(),
          hourlyRateOverride: Number(aiHourlyRate) || undefined,
        },
      })
      const result = res.data
      // Populate the form fields from the AI response so the user can review.
      setDescription(result.description)
      setReason(result.reason)
      setLineItems(result.line_items.map(li => ({
        name: li.name,
        quantity: li.quantity,
        unitPrice: li.unit_price,
        lineTotal: li.line_total,
      })))
      // Switch to manual mode so the user can edit + save.
      setMode('manual')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the change order. Try again.')
    } finally {
      timers.forEach(t => window.clearTimeout(t))
      setAiLoading(false)
      setAiLoadingMessage('')
    }
  }

  const delta = useMemo(
    () => +lineItems.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0).toFixed(2),
    [lineItems],
  )
  const newTotal = +(originalTotal + delta).toFixed(2)

  const updateLine = (i: number, patch: Partial<ChangeOrderLine>) => {
    setLineItems(prev => prev.map((l, idx) => {
      if (idx !== i) return l
      const next = { ...l, ...patch }
      next.lineTotal = +((Number(next.quantity) || 0) * (Number(next.unitPrice) || 0)).toFixed(2)
      return next
    }))
  }

  const addLine = () => setLineItems(prev => [...prev, { name: '', quantity: 1, unitPrice: 0, lineTotal: 0 }])
  const removeLine = (i: number) => setLineItems(prev => prev.filter((_, idx) => idx !== i))

  const save = async () => {
    if (!description.trim()) { setError('Please describe what changed.'); return }
    const validLines = lineItems.filter(l => l.name.trim() && (Number(l.quantity) || 0) !== 0)
    if (validLines.length === 0) { setError('Add at least one line item with a name and quantity.'); return }
    if (!user?.id) { setError('Not signed in.'); return }
    setError('')
    setSaving(true)
    try {
      const payload: Omit<ChangeOrder, 'id'> = {
        projectId,
        customerName,
        description: description.trim(),
        reason,
        lineItems: validLines,
        originalTotal,
        delta,
        newTotal,
        status: 'pending',
        createdAt: existing?.createdAt || new Date().toISOString(),
        createdBy: user.id,
      }
      let savedId: string
      if (existing?.id) {
        await updateDoc(doc(db, 'changeOrders', existing.id), payload as Record<string, unknown>)
        savedId = existing.id
      } else {
        const ref = await addDoc(collection(db, 'changeOrders'), payload)
        savedId = ref.id
      }
      onSaved({ id: savedId, ...payload })
    } catch (err) {
      setError('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '12px', border: '1px solid #e2e8f0' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 200, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '720px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>{existing ? 'Edit Change Order' : 'New Change Order'}</h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>For <strong>{customerName}</strong> · Original total ${originalTotal.toFixed(2)}</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: 'white', border: '1px solid #475569', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}>Close</button>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Mode toggle: AI generate vs. manual entry */}
          {!existing && (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <button
                onClick={() => setMode('ai')}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: mode === 'ai' ? '2px solid #7c3aed' : '1px solid #e2e8f0', background: mode === 'ai' ? '#faf5ff' : 'white', cursor: 'pointer', fontWeight: 700, fontSize: '13px', color: mode === 'ai' ? '#7c3aed' : '#64748b' }}
              >
                ✨ Generate for me
              </button>
              <button
                onClick={() => setMode('manual')}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: mode === 'manual' ? '2px solid #f97316' : '1px solid #e2e8f0', background: mode === 'manual' ? '#fff7ed' : 'white', cursor: 'pointer', fontWeight: 700, fontSize: '13px', color: mode === 'manual' ? '#f97316' : '#64748b' }}
              >
                ✍️ Enter Manually
              </button>
            </div>
          )}

          {/* AI input panel */}
          {mode === 'ai' && !existing && (
            <div style={{ ...card, border: '2px dashed #a78bfa', background: '#faf5ff' }}>
              <h3 style={{ margin: '0 0 4px', fontSize: '15px', color: '#6d28d9' }}>✨ Describe what changed</h3>
              <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#64748b' }}>
                Plain English. We'll figure out the line items + pricing using the same engine Quick Quote uses (NC fair-market rates).
              </p>
              <textarea
                value={aiDescription}
                onChange={e => setAiDescription(e.target.value)}
                rows={4}
                placeholder="e.g. 'Customer wants to upgrade from ceramic to subway tile in the shower — about 30 sqft. Also add caulking around the new tub surround.'"
                style={{ ...input, fontFamily: 'inherit', resize: 'vertical', marginBottom: '10px' }}
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginBottom: '10px' }}>
                <div>
                  <label style={{ ...label, fontSize: '10px' }}>Your hourly rate ($/hr)</label>
                  <input type="number" value={aiHourlyRate} onChange={e => setAiHourlyRate(e.target.value)} style={input} placeholder="65" />
                </div>
              </div>
              {aiLoading && (
                <p style={{ fontSize: '13px', color: '#7c3aed', display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 10px' }}>
                  <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  {aiLoadingMessage}
                </p>
              )}
              <button onClick={runAI} disabled={aiLoading || !aiDescription.trim()} style={{ background: aiLoading || !aiDescription.trim() ? '#cbd5e1' : '#7c3aed', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: aiLoading || !aiDescription.trim() ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
                {aiLoading ? 'Generating…' : '✨ Generate Change Order'}
              </button>
              {error && <p style={{ color: '#dc2626', fontSize: '13px', margin: '8px 0 0' }}>⚠ {error}</p>}
            </div>
          )}

          {/* Manual form fields — shown when mode === 'manual' OR when editing existing */}
          {mode === 'manual' && (
          <>
          <div style={card}>
            <label style={label}>What changed? *</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              placeholder="e.g. Customer upgraded from ceramic to subway tile in the shower"
              style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </div>

          <div style={card}>
            <label style={label}>Reason</label>
            <select value={reason} onChange={e => setReason(e.target.value as ChangeOrder['reason'])} style={input}>
              {REASONS.map(r => <option key={r} value={r}>{CHANGE_ORDER_REASON_LABEL[r]}</option>)}
            </select>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={label as React.CSSProperties}>Line items</span>
              <button onClick={addLine} style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>+ Add line</button>
            </div>
            <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 8px' }}>Use a <strong>positive</strong> quantity for additions, <strong>negative</strong> for credits/removals (e.g. qty -1 to deduct one item).</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {lineItems.map((l, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr)) auto', gap: '8px', alignItems: 'end' }}>
                  <div style={{ gridColumn: '1 / -2' }}>
                    <label style={{ ...label, fontSize: '10px' }}>Item</label>
                    <input value={l.name} onChange={e => updateLine(i, { name: e.target.value })} placeholder="e.g. Subway tile" style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Qty</label>
                    <input type="number" step="any" value={l.quantity} onChange={e => updateLine(i, { quantity: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Unit $</label>
                    <input type="number" step="0.01" value={l.unitPrice} onChange={e => updateLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div style={{ minWidth: '80px', textAlign: 'right', fontWeight: 700, fontSize: '14px', color: l.lineTotal < 0 ? '#16a34a' : '#1a1f2e' }}>
                    {l.lineTotal < 0 ? '−' : ''}${Math.abs(l.lineTotal).toFixed(2)}
                  </div>
                  <button onClick={() => removeLine(i)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '6px' }}>×</button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ ...card, background: '#1a1f2e', color: 'white', border: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Original total</span><span style={{ fontWeight: 600 }}>${originalTotal.toFixed(2)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}>
              <span style={{ color: '#cbd5e1' }}>Change order {delta >= 0 ? '+' : '−'}</span>
              <span style={{ fontWeight: 700, color: delta >= 0 ? '#fb923c' : '#86efac' }}>{delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #f97316', paddingTop: '12px', marginTop: '8px' }}>
              <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>New total</span>
              <span style={{ color: '#f97316', fontSize: '24px', fontWeight: 700 }}>${newTotal.toFixed(2)}</span>
            </div>
          </div>

          {error && <p style={{ color: '#dc2626', fontSize: '13px' }}>⚠ {error}</p>}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button onClick={save} disabled={saving} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
              {saving ? 'Saving…' : existing ? '💾 Save changes' : '💾 Create & Send to Customer'}
            </button>
            <button onClick={onClose} style={{ background: '#f1f5f9', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
