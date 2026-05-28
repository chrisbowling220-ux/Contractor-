import { useState, useMemo } from 'react'
import { useUser } from '@clerk/clerk-react'
import { addDoc, updateDoc, doc, collection } from 'firebase/firestore'
import { db } from './firebase'
import { MATERIALS } from './data/materials'
import type { Estimate, MaterialLine, Project } from './data/types'

interface Props {
  // Pre-fill customer if launched from a known context.
  defaultCustomerName?: string
  defaultCustomerId?: string
  onClose: () => void
  // Called with the saved estimate so the caller can open it / navigate.
  onSaved: (estimate: Estimate) => void
}

type Row = { key: string; materialId: string; name: string; unit: string; quantity: string; unitPrice: string }

let rowSeq = 0
const newRow = (): Row => ({ key: `r${rowSeq++}`, materialId: '', name: '', unit: '', quantity: '1', unitPrice: '' })

// A fully manual estimate builder — no AI. Pick materials from the catalog
// (auto-fills unit + price) or type custom rows, set labor, and save. Produces
// a standard Estimate (no aiQuote) that flows into projects, print, share, and
// invoices exactly like an instant quote. Always available; the only way to
// estimate once the free instant-quote tier is used up.
export default function ManualEstimateBuilder({ defaultCustomerName, defaultCustomerId, onClose, onSaved }: Props) {
  const { user } = useUser()
  const [customerName, setCustomerName] = useState(defaultCustomerName || '')
  const [jobTypeName, setJobTypeName] = useState('')
  const [zip, setZip] = useState('')
  const [scope, setScope] = useState('')
  const [rateType, setRateType] = useState<'hourly' | 'flat'>('hourly')
  const [hourlyRate, setHourlyRate] = useState('65')
  const [hours, setHours] = useState('')
  const [flatAmount, setFlatAmount] = useState('')
  const [rows, setRows] = useState<Row[]>([newRow()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const materialsTotal = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0), 0),
    [rows],
  )
  const laborTotal = useMemo(
    () => rateType === 'flat' ? (Number(flatAmount) || 0) : (Number(hours) || 0) * (Number(hourlyRate) || 0),
    [rateType, flatAmount, hours, hourlyRate],
  )
  const total = +(materialsTotal + laborTotal).toFixed(2)

  const pickMaterial = (key: string, materialId: string) => {
    const mat = MATERIALS.find(m => m.id === materialId)
    setRows(prev => prev.map(r => r.key === key
      ? mat
        ? { ...r, materialId, name: mat.name, unit: mat.unit, unitPrice: String(mat.basePrice) }
        : { ...r, materialId: '' }
      : r))
  }
  const updateRow = (key: string, patch: Partial<Row>) => setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r))
  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key))

  const save = async () => {
    if (!user?.id) { setError('Not signed in.'); return }
    if (!customerName.trim()) { setError('Customer name is required.'); return }
    if (!jobTypeName.trim()) { setError('Job type / title is required.'); return }
    setSaving(true)
    setError('')
    try {
      const materials: MaterialLine[] = rows
        .filter(r => r.name.trim() && (Number(r.quantity) || 0) > 0)
        .map(r => ({
          materialId: r.materialId || 'custom',
          name: r.name.trim(),
          quantity: Number(r.quantity) || 0,
          unit: r.unit.trim() || 'each',
          unitPrice: Number(r.unitPrice) || 0,
        }))

      // Build a readable scope-of-work that lists the line items, so the
      // customer-facing estimate page (which shows scopeOfWork for non-AI
      // estimates) displays everything.
      const lines: string[] = []
      lines.push(`SCOPE OF WORK\n\nCLIENT: ${customerName.trim()}\nJOB: ${jobTypeName.trim()}`)
      if (scope.trim()) lines.push(`\n${scope.trim()}`)
      if (materials.length > 0) {
        lines.push('\nMATERIALS:')
        materials.forEach(m => lines.push(`  • ${m.name} — ${m.quantity} ${m.unit} × $${m.unitPrice.toFixed(2)} = $${(m.quantity * m.unitPrice).toFixed(2)}`))
        lines.push(`  Materials subtotal: $${materialsTotal.toFixed(2)}`)
      }
      lines.push(rateType === 'flat'
        ? `\nLABOR: $${laborTotal.toFixed(2)} (flat)`
        : `\nLABOR: ${Number(hours) || 0} hrs × $${Number(hourlyRate) || 0}/hr = $${laborTotal.toFixed(2)}`)
      lines.push(`\nTOTAL: $${total.toFixed(2)}`)

      const payload: Record<string, unknown> = {
        customerName: customerName.trim(),
        jobTypeId: 'manual',
        jobTypeName: jobTypeName.trim(),
        description: scope.trim().slice(0, 500),
        rateType,
        hourlyRate: Number(hourlyRate) || 0,
        estimatedHours: Number(hours) || 0,
        ...(rateType === 'flat' ? { flatAmount: Number(flatAmount) || 0 } : {}),
        laborTotal: +laborTotal.toFixed(2),
        materials,
        materialsTotal: +materialsTotal.toFixed(2),
        rentals: [],
        rentalsTotal: 0,
        jobLocationZip: zip.trim(),
        jobLocationRegion: '',
        regionMultiplier: 1,
        total,
        scopeOfWork: lines.join('\n'),
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdBy: user.id,
      }
      if (defaultCustomerId) payload.customerId = defaultCustomerId

      const ref = await addDoc(collection(db, 'estimates'), payload)

      // Mirror Quick Quote: create a project at "lead" so it lands in Projects.
      try {
        const projectPayload: Omit<Project, 'id'> = {
          customerName: customerName.trim(),
          ...(defaultCustomerId ? { customerId: defaultCustomerId } : {}),
          jobTypeName: jobTypeName.trim(),
          jobLocationZip: zip.trim(),
          description: scope.trim().slice(0, 500),
          status: 'lead',
          notes: `Created manually on ${new Date().toLocaleDateString()}.`,
          createdAt: new Date().toISOString(),
          createdBy: user.id,
          sourceEstimateId: ref.id,
          estimateTotal: total,
        }
        const pRef = await addDoc(collection(db, 'projects'), projectPayload)
        await updateDoc(doc(db, 'estimates', ref.id), { projectAutoCreated: true, projectId: pRef.id })
      } catch (projErr) {
        console.warn('Manual estimate: project auto-create failed', projErr)
      }

      onSaved({ id: ref.id, ...payload } as Estimate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      setSaving(false)
    }
  }

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 250, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '720px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>✍️ Build Estimate Manually</h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>No limits — pick materials from the list or type your own.</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: 'white', border: '1px solid #475569', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}>← Back</button>
        </div>

        <div style={{ padding: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            <div><label style={label}>Customer name *</label><input value={customerName} onChange={e => setCustomerName(e.target.value)} style={input} placeholder="e.g. Sarah Miller" /></div>
            <div><label style={label}>Job type / title *</label><input value={jobTypeName} onChange={e => setJobTypeName(e.target.value)} style={input} placeholder="e.g. Bathroom remodel" /></div>
            <div><label style={label}>Job ZIP</label><input value={zip} onChange={e => setZip(e.target.value)} style={input} placeholder="27573" /></div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={label}>Scope / description (optional)</label>
            <textarea value={scope} onChange={e => setScope(e.target.value)} rows={3} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} placeholder="What's the work? This shows on the customer's estimate." />
          </div>

          {/* Materials */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: '15px' }}>🧱 Materials</h3>
            {rows.map(r => (
              <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.7fr 0.9fr auto', gap: '6px', marginBottom: '8px', alignItems: 'center' }}>
                <div>
                  <select value={r.materialId} onChange={e => pickMaterial(r.key, e.target.value)} style={{ ...input, padding: '8px', marginBottom: '4px' }}>
                    <option value="">— Pick or type custom —</option>
                    {MATERIALS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <input value={r.name} onChange={e => updateRow(r.key, { name: e.target.value, materialId: '' })} style={{ ...input, padding: '8px' }} placeholder="Custom item name" />
                </div>
                <input type="number" value={r.quantity} onChange={e => updateRow(r.key, { quantity: e.target.value })} style={{ ...input, padding: '8px' }} placeholder="Qty" />
                <input value={r.unit} onChange={e => updateRow(r.key, { unit: e.target.value })} style={{ ...input, padding: '8px' }} placeholder="unit" />
                <input type="number" value={r.unitPrice} onChange={e => updateRow(r.key, { unitPrice: e.target.value })} style={{ ...input, padding: '8px' }} placeholder="$ each" />
                <button onClick={() => removeRow(r.key)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }} title="Remove">×</button>
              </div>
            ))}
            <button onClick={() => setRows(prev => [...prev, newRow()])} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', marginTop: '4px' }}>+ Add material</button>
            <p style={{ textAlign: 'right', margin: '10px 0 0', fontWeight: 700 }}>Materials: ${materialsTotal.toFixed(2)}</p>
          </div>

          {/* Labor */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: '15px' }}>👷 Labor</h3>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
              <button onClick={() => setRateType('hourly')} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: rateType === 'hourly' ? '2px solid #f97316' : '1px solid #e2e8f0', background: rateType === 'hourly' ? '#fff7ed' : 'white', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}>Hourly</button>
              <button onClick={() => setRateType('flat')} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: rateType === 'flat' ? '2px solid #f97316' : '1px solid #e2e8f0', background: rateType === 'flat' ? '#fff7ed' : 'white', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}>Flat rate</button>
            </div>
            {rateType === 'hourly' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div><label style={label}>Hours</label><input type="number" value={hours} onChange={e => setHours(e.target.value)} style={input} placeholder="0" /></div>
                <div><label style={label}>Rate ($/hr)</label><input type="number" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} style={input} placeholder="65" /></div>
              </div>
            ) : (
              <div><label style={label}>Flat labor amount ($)</label><input type="number" value={flatAmount} onChange={e => setFlatAmount(e.target.value)} style={input} placeholder="0" /></div>
            )}
            <p style={{ textAlign: 'right', margin: '10px 0 0', fontWeight: 700 }}>Labor: ${laborTotal.toFixed(2)}</p>
          </div>

          <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span style={{ color: '#fb923c', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Total</span>
            <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${total.toFixed(2)}</span>
          </div>

          {error && <p style={{ color: '#dc2626', fontSize: '14px', margin: '0 0 12px' }}>⚠ {error}</p>}

          <button onClick={save} disabled={saving} style={{ width: '100%', background: saving ? '#cbd5e1' : '#16a34a', color: 'white', border: 'none', padding: '14px', borderRadius: '8px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
            {saving ? 'Saving…' : 'Save Estimate →'}
          </button>
          <button onClick={onClose} style={{ width: '100%', marginTop: '8px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
