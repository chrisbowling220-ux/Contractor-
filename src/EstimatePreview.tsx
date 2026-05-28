import { useState, useEffect, useMemo } from 'react'
import { useAuth, useUser } from '@clerk/clerk-react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { toCustomerView } from './lib/customerView'
import { copyShareLink, shareLinkFor, smsHref, mailtoHref, nativeShare, isPhone } from './lib/shareEstimate'
import type { Estimate, AIQuote, AIMaterialLine } from './data/types'

interface Props {
  estimate: Estimate
  onClose: () => void
  onSaved: (updated: Estimate) => void
  onPrint: (e: Estimate) => void
}

// Editable customer-facing preview of an estimate. Edits are saved back to
// Firestore on Save; the public share view, print, SMS link, and Copy link all
// pull from the saved version.
export default function EstimatePreview({ estimate, onClose, onSaved, onPrint }: Props) {
  const { user } = useUser()
  const { getToken: _getToken } = useAuth()
  void _getToken

  // Always work from a customer-view shaped quote so markup is baked in.
  const initialAi: AIQuote | null = estimate.aiQuote ? toCustomerView(estimate.aiQuote) : null

  const [customerName, setCustomerName] = useState(estimate.customerName || '')
  const [customerSummary, setCustomerSummary] = useState(initialAi?.customer_summary || '')
  const [workScope, setWorkScope] = useState(initialAi?.work_scope || estimate.scopeOfWork || '')
  const [materials, setMaterials] = useState<AIMaterialLine[]>(initialAi?.material_list || [])
  const [hourlyRate, setHourlyRate] = useState(String(initialAi?.labor.hourly_rate ?? estimate.hourlyRate ?? 65))
  const [estimatedHours, setEstimatedHours] = useState(String(initialAi?.labor.estimated_hours ?? estimate.estimatedHours ?? 0))
  const [rentalsTotal, setRentalsTotal] = useState(String(initialAi?.price_breakdown.rentals_subtotal ?? estimate.rentalsTotal ?? 0))
  const [contractorNotes, setContractorNotes] = useState(initialAi?.contractor_notes || '')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    // Mark dirty when any field changes after first render. Initial sync is
    // not a change.
    setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerName, customerSummary, workScope, materials, hourlyRate, estimatedHours, rentalsTotal, contractorNotes])

  // Reset dirty on mount.
  useEffect(() => { setDirty(false) }, [])

  // Live recalculation. Markup is baked into materials already (customer view),
  // so total = labor + materials + rentals.
  const computed = useMemo(() => {
    const materialsSubtotal = +materials.reduce((s, m) => s + (Number(m.line_total) || 0), 0).toFixed(2)
    const laborSubtotal = +((Number(hourlyRate) || 0) * (Number(estimatedHours) || 0)).toFixed(2)
    const rentals = Number(rentalsTotal) || 0
    const total = +(materialsSubtotal + laborSubtotal + rentals).toFixed(2)
    return { materialsSubtotal, laborSubtotal, rentals, total }
  }, [materials, hourlyRate, estimatedHours, rentalsTotal])

  const updateMaterial = (i: number, patch: Partial<AIMaterialLine>) => {
    setMaterials(prev => prev.map((m, idx) => {
      if (idx !== i) return m
      const next = { ...m, ...patch }
      // Recompute line total whenever qty or unit price changes.
      next.line_total = +(Number(next.quantity_with_waste) * Number(next.unit_price)).toFixed(2)
      return next
    }))
  }

  const removeMaterial = (i: number) => setMaterials(prev => prev.filter((_, idx) => idx !== i))

  const addMaterial = () => {
    setMaterials(prev => [...prev, {
      name: 'New item',
      base_quantity: 1,
      waste_percent: 0,
      quantity_with_waste: 1,
      quantity_math: '',
      unit: 'each',
      unit_price: 0,
      line_total: 0,
    }])
  }

  const buildEditedQuote = (): AIQuote => ({
    customer_summary: customerSummary,
    work_scope: workScope,
    material_list: materials,
    labor: {
      estimated_hours: Number(estimatedHours) || 0,
      breakdown: initialAi?.labor.breakdown || '',
      hourly_rate: Number(hourlyRate) || 0,
      labor_total: computed.laborSubtotal,
    },
    price_breakdown: {
      labor_subtotal: computed.laborSubtotal,
      materials_subtotal: computed.materialsSubtotal,
      rentals_subtotal: computed.rentals,
      raw_cost: computed.total,
    },
    profit_markup: {
      markup_percent: 0,
      markup_dollars: 0,
      rationale: '',
    },
    final_customer_quote: computed.total,
    contractor_notes: contractorNotes,
  })

  const saveEdits = async () => {
    setSaving(true)
    setSaveStatus('')
    try {
      const editedQuote = buildEditedQuote()
      const updates: Record<string, unknown> = {
        customerName,
        aiQuote: editedQuote,
        total: computed.total,
        laborTotal: computed.laborSubtotal,
        materialsTotal: computed.materialsSubtotal,
        rentalsTotal: computed.rentals,
        hourlyRate: Number(hourlyRate) || 0,
        estimatedHours: Number(estimatedHours) || 0,
        scopeOfWork: `SCOPE OF WORK — ${estimate.jobTypeName}\n\nCLIENT: ${customerName}\n\nSUMMARY:\n${customerSummary}\n\n${workScope}`,
      }
      await updateDoc(doc(db, 'estimates', estimate.id), updates)
      const updated: Estimate = { ...estimate, ...updates } as Estimate
      onSaved(updated)
      setDirty(false)
      setSaveStatus('✓ Saved')
      setTimeout(() => setSaveStatus(''), 2500)
    } catch (err) {
      setSaveStatus('⚠ Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const requireSaveBeforeSend = (action: () => void | Promise<void>) => async () => {
    if (dirty) {
      if (!confirm('You have unsaved edits. Save before sharing?')) return
      await saveEdits()
    }
    await action()
  }

  const fromName = user?.fullName || user?.firstName || undefined

  const doShare = requireSaveBeforeSend(async () => {
    const ok = await nativeShare(estimate, fromName)
    if (!ok) {
      const copied = await copyShareLink(estimate.id)
      if (copied) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500) }
    }
  })

  const doCopy = requireSaveBeforeSend(async () => {
    const ok = await copyShareLink(estimate.id)
    if (ok) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500) }
    else setSaveStatus(`Manual link: ${shareLinkFor(estimate.id)}`)
  })

  const doPrint = requireSaveBeforeSend(async () => {
    onPrint({ ...estimate, aiQuote: buildEditedQuote(), customerName, total: computed.total } as Estimate)
  })

  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '12px', border: '1px solid #e2e8f0' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 200, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '780px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>Edit & Send Estimate</h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>Customer-facing preview. Markup is baked in — no markup line is shown.</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: 'white', border: '1px solid #475569', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}>Close</button>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Header card — customer name */}
          <div style={card}>
            <label style={label}>Customer Name</label>
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} style={input} />
            <p style={{ fontSize: '12px', color: '#64748b', margin: '6px 0 0' }}>
              {estimate.jobTypeName} · ZIP {estimate.jobLocationZip} · {new Date(estimate.createdAt).toLocaleDateString()}
            </p>
          </div>

          {/* Customer summary */}
          <div style={card}>
            <label style={label}>Customer Summary (prose paragraph shown to the customer)</label>
            <textarea value={customerSummary} onChange={e => setCustomerSummary(e.target.value)} rows={4} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
          </div>

          {/* Work scope */}
          <div style={card}>
            <label style={label}>Work Scope</label>
            <textarea value={workScope} onChange={e => setWorkScope(e.target.value)} rows={8} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
          </div>

          {/* Materials */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={label as React.CSSProperties}>Materials</span>
              <button onClick={addMaterial} style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>+ Add item</button>
            </div>
            {materials.length === 0 && <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>No materials. Click + Add item to include some.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {materials.map((m, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr)) auto', gap: '8px', alignItems: 'end' }}>
                  <div style={{ gridColumn: '1 / -2' }}>
                    <label style={{ ...label, fontSize: '10px' }}>Item</label>
                    <input value={m.name} onChange={e => updateMaterial(i, { name: e.target.value })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Qty</label>
                    <input type="number" value={m.quantity_with_waste} onChange={e => updateMaterial(i, { quantity_with_waste: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Unit</label>
                    <input value={m.unit} onChange={e => updateMaterial(i, { unit: e.target.value })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Unit $</label>
                    <input type="number" step="0.01" value={m.unit_price} onChange={e => updateMaterial(i, { unit_price: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div style={{ minWidth: '70px', textAlign: 'right', fontWeight: 700, fontSize: '14px' }}>
                    ${m.line_total.toFixed(2)}
                  </div>
                  <button onClick={() => removeMaterial(i)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '6px' }}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Labor */}
          <div style={card}>
            <span style={label as React.CSSProperties}>Labor</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Estimated Hours</label>
                <input type="number" step="0.25" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} style={input} />
              </div>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Hourly Rate ($/hr)</label>
                <input type="number" step="1" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} style={input} />
              </div>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Labor Total</label>
                <div style={{ padding: '8px 10px', background: '#f1f5f9', borderRadius: '6px', fontWeight: 700, fontSize: '14px' }}>${computed.laborSubtotal.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Rentals (simple editable total, kept lightweight) */}
          {(computed.rentals > 0 || Number(rentalsTotal) > 0) && (
            <div style={card}>
              <label style={label}>Rentals Total</label>
              <input type="number" step="0.01" value={rentalsTotal} onChange={e => setRentalsTotal(e.target.value)} style={input} />
            </div>
          )}

          {/* Contractor notes */}
          <div style={card}>
            <label style={label}>🔒 Contractor Notes (private — not shown to customer)</label>
            <textarea value={contractorNotes} onChange={e => setContractorNotes(e.target.value)} rows={3} style={{ ...input, fontFamily: 'inherit', resize: 'vertical', background: '#fef3c7' }} />
          </div>

          {/* Live totals */}
          <div style={{ ...card, background: '#1a1f2e', color: 'white', border: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Materials</span><span style={{ fontWeight: 600 }}>${computed.materialsSubtotal.toFixed(2)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Labor ({estimatedHours}h × ${hourlyRate}/hr)</span><span style={{ fontWeight: 600 }}>${computed.laborSubtotal.toFixed(2)}</span></div>
            {computed.rentals > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Rentals</span><span style={{ fontWeight: 600 }}>${computed.rentals.toFixed(2)}</span></div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #f97316', paddingTop: '12px', marginTop: '8px' }}>
              <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Grand Total</span>
              <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${computed.total.toFixed(2)}</span>
            </div>
          </div>

          {/* Save + share row */}
          <div style={{ position: 'sticky', bottom: 0, background: 'rgba(248,250,252,0.95)', backdropFilter: 'blur(4px)', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0', marginTop: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={saveEdits} disabled={saving || !dirty} style={{ background: dirty ? '#f97316' : '#cbd5e1', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: dirty ? 'pointer' : 'not-allowed', fontWeight: 700 }}>
                {saving ? 'Saving…' : dirty ? '💾 Save Changes' : '✓ Up to date'}
              </button>
              <div style={{ width: '1px', height: '24px', background: '#cbd5e1', margin: '0 4px' }} />
              {/* Native share sheet — phones only. On desktops navigator.share is
                  unavailable; doShare falls back to copy-link automatically. */}
              {isPhone() && (
                <button onClick={doShare} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                  📤 Share
                </button>
              )}
              {/* SMS link — phones only (laptops don't have an SMS app). */}
              {isPhone() && (
                <a href={smsHref({ ...estimate, customerName }, fromName)} onClick={() => dirty && saveEdits()} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
                  💬 Text
                </a>
              )}
              {/* Email link — works on every device. Opens user's default mail app. */}
              <a href={mailtoHref({ ...estimate, customerName }, fromName)} onClick={() => dirty && saveEdits()} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
                ✉️ Email
              </a>
              <button onClick={doCopy} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                {linkCopied ? '✓ Copied' : '🔗 Copy link'}
              </button>
              <button onClick={doPrint} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                🖨️ Print / PDF
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#64748b' }}>
              <strong>Copy link</strong> works on any device and any messaging app — paste it anywhere. <strong>Text/Share</strong> only on phones.
            </p>
            {saveStatus && <p style={{ margin: '8px 0 0', fontSize: '13px', color: saveStatus.startsWith('✓') ? '#16a34a' : '#dc2626' }}>{saveStatus}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
