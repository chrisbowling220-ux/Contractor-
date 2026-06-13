import { useState, useEffect, useMemo } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, orderBy, doc, updateDoc, where } from 'firebase/firestore'
import { useAuth, useUser } from '@clerk/clerk-react'
import { JOB_CATALOG, JOB_CATEGORIES } from './data/jobCatalog'
import { estimateMaterials, regionFromZip, ROOM_TYPES, DEFAULT_ZIP } from './data/materials'
import { RENTAL_EQUIPMENT } from './data/rentals'
import type { AIQuote, Estimate, MaterialLine, RentalLine } from './data/types'
import { aiQuoteToScopeOfWork, generateAIQuote } from './lib/aiQuote'
import { buildFallbackQuote } from './lib/fallbackQuote'
import { toCustomerView } from './lib/customerView'

export default function Estimates() {
  const { user } = useUser()
  const { getToken } = useAuth()
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [customerName, setCustomerName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [jobTypeId, setJobTypeId] = useState(JOB_CATALOG[0].id)
  const [description, setDescription] = useState('')
  const [jobLocationZip, setJobLocationZip] = useState(DEFAULT_ZIP)
  const [rateType, setRateType] = useState<'flat' | 'hourly'>('flat')
  const [flatAmount, setFlatAmount] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  const [estimatedHours, setEstimatedHours] = useState('')
  const [jobCategoryFilter, setJobCategoryFilter] = useState('All')
  const [jobSearch, setJobSearch] = useState('')

  const [includeMaterials, setIncludeMaterials] = useState(false)
  const [roomType, setRoomType] = useState('bathroom')
  const [roomLength, setRoomLength] = useState('10')
  const [roomWidth, setRoomWidth] = useState('8')
  const [roomHeight, setRoomHeight] = useState('8')
  const [materialLines, setMaterialLines] = useState<MaterialLine[]>([])

  const [includeRentals, setIncludeRentals] = useState(false)
  const [rentalLines, setRentalLines] = useState<RentalLine[]>([])
  const [selectedRentalId, setSelectedRentalId] = useState(RENTAL_EQUIPMENT[0].id)
  const [rentalDays, setRentalDays] = useState('1')

  const [aiQuote, setAiQuote] = useState<AIQuote | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiLoadingMessage, setAiLoadingMessage] = useState('')
  const [aiError, setAiError] = useState('')
  const [aiUsedFallback, setAiUsedFallback] = useState(false)
  const [aiHourlyRate, setAiHourlyRate] = useState('65')
  const [aiMarkupPct, setAiMarkupPct] = useState('20')

  const fetchEstimates = async () => {
    if (!user?.id) { setEstimates([]); return }
    try {
      const q = query(
        collection(db, 'estimates'),
        where('createdBy', '==', user.id),
        orderBy('createdAt', 'desc'),
      )
      const snapshot = await getDocs(q)
      setEstimates(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Estimate)))
    } catch {
      setEstimates([])
    }
  }
  useEffect(() => { fetchEstimates() }, [user?.id])

  useEffect(() => {
    if (!user?.id) return
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'customers'),
          where('createdBy', '==', user.id),
          orderBy('createdAt', 'desc'),
        ))
        setCustomers(snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) || '' })))
      } catch {}
    })()
  }, [user?.id])

  const selectedJob = useMemo(() => JOB_CATALOG.find(j => j.id === jobTypeId) ?? JOB_CATALOG[0], [jobTypeId])
  const { multiplier, region } = useMemo(() => regionFromZip(jobLocationZip), [jobLocationZip])
  const validZip = /^[0-9]{5}$/.test(jobLocationZip)

  const filteredJobs = JOB_CATALOG.filter(j => {
    if (jobCategoryFilter !== 'All' && j.category !== jobCategoryFilter) return false
    if (jobSearch && !j.name.toLowerCase().includes(jobSearch.toLowerCase())) return false
    return true
  })

  const laborTotal = useMemo(() => {
    if (rateType === 'flat') {
      const base = Number(flatAmount) || 0
      return validZip ? +(base * multiplier).toFixed(2) : base
    }
    const base = (Number(hourlyRate) || 0) * (Number(estimatedHours) || 0)
    return validZip ? +(base * multiplier).toFixed(2) : base
  }, [rateType, flatAmount, hourlyRate, estimatedHours, multiplier, validZip])

  const materialsTotal = materialLines.reduce((s, m) => s + m.quantity * m.unitPrice, 0)
  const rentalsTotal = rentalLines.reduce((s, r) => s + r.days * r.dailyRate, 0)
  const total = laborTotal + materialsTotal + rentalsTotal

  const runMaterialScan = () => {
    const lines = estimateMaterials(roomType, Number(roomLength), Number(roomWidth), Number(roomHeight))
    const adjusted = validZip ? lines.map(l => ({ ...l, unitPrice: +(l.unitPrice * multiplier).toFixed(2) })) : lines
    setMaterialLines(adjusted)
  }

  const addRental = () => {
    const r = RENTAL_EQUIPMENT.find(x => x.id === selectedRentalId)
    if (!r) return
    setRentalLines([...rentalLines, { rentalId: r.id, name: r.name, days: Number(rentalDays) || 1, dailyRate: r.dailyRate, deposit: r.deposit }])
    setRentalDays('1')
  }

  const removeRental = (i: number) => setRentalLines(rentalLines.filter((_, idx) => idx !== i))
  const updateMaterialQty = (i: number, qty: number) => setMaterialLines(materialLines.map((m, idx) => idx === i ? { ...m, quantity: Math.max(0, qty) } : m))

  const resetForm = () => {
    setCustomerName(''); setCustomerId(''); setDescription(''); setJobLocationZip(DEFAULT_ZIP); setFlatAmount(''); setHourlyRate(''); setEstimatedHours('')
    setMaterialLines([]); setRentalLines([]); setIncludeMaterials(false); setIncludeRentals(false)
    setAiQuote(null); setAiError('')
  }

  const runAIGenerator = async () => {
    if (!customerName || !selectedJob) {
      setAiError('Add a customer name and pick a job type first.')
      return
    }
    setAiLoading(true)
    setAiError('')
    setAiUsedFallback(false)
    setAiLoadingMessage('Generating your quote…')

    // Progressive loading messages while the backend retries (it retries up to
    // 3 times with 2s delays, so the user may be waiting 6–30s).
    const messageTimers: number[] = []
    messageTimers.push(window.setTimeout(() => setAiLoadingMessage('Still working — Claude is thinking through the scope…'), 8000))
    messageTimers.push(window.setTimeout(() => setAiLoadingMessage('Anthropic seems busy. Retrying behind the scenes…'), 15000))
    messageTimers.push(window.setTimeout(() => setAiLoadingMessage('One more try — this can take up to 30s when the API is overloaded…'), 22000))

    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const q = await generateAIQuote(
        {
          customerName,
          jobTypeName: selectedJob.name,
          description,
          jobLocationZip,
          jobLocationRegion: region,
          regionMultiplier: multiplier,
          rateType,
          hourlyRate: rateType === 'hourly' ? Number(hourlyRate) || 0 : undefined,
          estimatedHours: rateType === 'hourly' ? Number(estimatedHours) || 0 : undefined,
          flatAmount: rateType === 'flat' ? Number(flatAmount) || 0 : undefined,
          laborTotal,
          materials: materialLines,
          rentals: rentalLines,
          hourlyRateOverride: Number(aiHourlyRate) || undefined,
          markupPercentOverride: aiMarkupPct === '' ? undefined : Number(aiMarkupPct),
          debugForceFail: new URLSearchParams(window.location.search).get('debugForceFail') || undefined,
        },
        clerkToken,
      )
      setAiQuote(q)
    } catch (err) {
      // All 3 retries failed. Fall back to a locally-calculated quote so the
      // contractor isn't stuck staring at an error.
      const errMsg = err instanceof Error ? err.message : String(err)
      try {
        const fallback = buildFallbackQuote({
          customerName,
          jobTypeName: selectedJob.name,
          description,
          jobLocationZip,
          materials: materialLines,
          rentals: rentalLines,
          hourlyRate: Number(aiHourlyRate) || 65,
          estimatedHours: Number(estimatedHours) || 0,
          markupPercent: Number(aiMarkupPct) || 20,
          flatAmount: rateType === 'flat' ? Number(flatAmount) || 0 : undefined,
          rateType,
        })
        setAiQuote(fallback)
        setAiUsedFallback(true)
        setAiError(`${errMsg} — showing a calculated estimate using your form inputs instead.`)
      } catch {
        setAiError(errMsg)
      }
    } finally {
      messageTimers.forEach(t => window.clearTimeout(t))
      setAiLoading(false)
      setAiLoadingMessage('')
    }
  }

  const handleSubmit = async () => {
    if (!customerName || !selectedJob) return
    setLoading(true)
    const scopeOfWork = aiQuote
      ? aiQuoteToScopeOfWork(aiQuote, customerName, selectedJob.name)
      : `SCOPE OF WORK — ${selectedJob.name}\n\nCLIENT: ${customerName}\n\nDESCRIPTION:\n${description}`
    const finalTotal = aiQuote ? aiQuote.final_customer_quote : total
    const payload: Omit<Estimate, 'id'> = {
      customerName,
      ...(customerId ? { customerId } : {}),
      jobTypeId: selectedJob.id,
      jobTypeName: selectedJob.name,
      description,
      rateType,
      flatAmount: rateType === 'flat' ? Number(flatAmount) || 0 : undefined,
      hourlyRate: rateType === 'hourly' ? Number(hourlyRate) || 0 : undefined,
      estimatedHours: rateType === 'hourly' ? Number(estimatedHours) || 0 : undefined,
      laborTotal,
      materials: materialLines,
      materialsTotal,
      rentals: rentalLines,
      rentalsTotal,
      jobLocationZip,
      jobLocationRegion: region,
      regionMultiplier: multiplier,
      total: finalTotal,
      scopeOfWork,
      ...(aiQuote ? { aiQuote } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdBy: user?.id,
    }
    try {
      await addDoc(collection(db, 'estimates'), payload)
    } catch (err) {
      // Don't lose the user's work silently — surface the failure and keep the
      // form open so they can retry.
      setLoading(false)
      window.alert(`Could not save estimate: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    resetForm()
    setShowForm(false)
    setLoading(false)
    fetchEstimates()
  }

  const statusColor = (s: string) => s === 'approved' ? { bg: '#f0fdf4', color: '#16a34a' } : s === 'declined' ? { bg: '#fef2f2', color: '#dc2626' } : { bg: '#fff7ed', color: '#ea580c' }

  const setStatus = async (id: string, status: Estimate['status']) => {
    await updateDoc(doc(db, 'estimates', id), { status })
    setEstimates(estimates.map(e => e.id === id ? { ...e, status } : e))
  }

  const printEstimate = (e: Estimate) => {
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) return
    // Customer-facing view: markup baked into material prices, no markup line.
    const ai = e.aiQuote ? toCustomerView(e.aiQuote) : undefined
    w.document.write(`<!doctype html><html><head><title>Estimate — ${e.customerName}</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1f2e; }
        h1 { color: #f97316; border-bottom: 2px solid #f97316; padding-bottom: 8px; }
        h2 { color: #1a1f2e; margin-top: 24px; font-size: 16px; text-transform: uppercase; letter-spacing: 1px; }
        pre { white-space: pre-wrap; font-family: inherit; background: #f8fafc; padding: 12px; border-radius: 6px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
        th, td { padding: 6px; border-bottom: 1px solid #e2e8f0; text-align: left; }
        .total { font-size: 28px; color: #f97316; font-weight: 700; text-align: right; margin-top: 16px; }
        .meta { color: #64748b; font-size: 13px; }
      </style></head><body>
      <h1>Estimate</h1>
      <p class="meta"><strong>Customer:</strong> ${e.customerName}<br/>
      <strong>Job:</strong> ${e.jobTypeName}<br/>
      <strong>Location:</strong> ${e.jobLocationZip} (${e.jobLocationRegion})<br/>
      <strong>Date:</strong> ${new Date(e.createdAt).toLocaleDateString()}</p>
      ${ai ? `<h2>Summary</h2><p>${ai.customer_summary}</p>
        <h2>Work Scope</h2><pre>${ai.work_scope}</pre>
        ${ai.material_list.length ? `<h2>Materials</h2><table><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Unit $</th><th>Total</th></tr>${ai.material_list.map(m => `<tr><td>${m.name}</td><td>${m.quantity_with_waste}</td><td>${m.unit}</td><td>$${m.unit_price.toFixed(2)}</td><td>$${m.line_total.toFixed(2)}</td></tr>`).join('')}</table>` : ''}
        <h2>Labor</h2><p>${ai.labor.estimated_hours}h @ $${ai.labor.hourly_rate}/hr — $${ai.labor.labor_total.toFixed(2)}</p>` : `<h2>Scope of Work</h2><pre>${e.scopeOfWork}</pre>`}
      <div class="total">Total: $${(e.total || 0).toFixed(2)}</div>
      <script>window.print()</script></body></html>`)
    w.document.close()
  }

  const selectedEstimate = estimates.find(e => e.id === selectedId)

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '24px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700 }}>Estimates</h2>
        <button onClick={() => setShowForm(!showForm)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>
          + New Estimate
        </button>
      </div>

      {showForm && (
        <>
          <div style={card}>
            <h3 style={{ marginBottom: '16px' }}>Customer & Job</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={label}>Customer *</label>
                {customers.length > 0 ? (
                  <select
                    value={customerId || '__new__'}
                    onChange={e => {
                      if (e.target.value === '__new__') { setCustomerId(''); setCustomerName('') }
                      else {
                        const c = customers.find(x => x.id === e.target.value)
                        setCustomerId(e.target.value); setCustomerName(c?.name || '')
                      }
                    }}
                    style={input}
                  >
                    <option value="__new__">+ New customer (type below)</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : (
                  <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0' }}>No saved customers — add one in the Customers page, or type a name below.</p>
                )}
                {!customerId && (
                  <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name" style={{ ...input, marginTop: '6px' }} />
                )}
              </div>
              <div>
                <label style={label}>Job Location ZIP *</label>
                <input value={jobLocationZip} onChange={e => setJobLocationZip(e.target.value)} maxLength={5} placeholder="e.g. 90210" style={input} />
                {validZip && <p style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px' }}>AI will price for {region}</p>}
              </div>
            </div>

            <h4 style={{ marginBottom: '8px', fontSize: '14px', color: '#64748b' }}>Job Type (every construction job)</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <select value={jobCategoryFilter} onChange={e => setJobCategoryFilter(e.target.value)} style={input}>
                <option value="All">All Categories</option>
                {JOB_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input placeholder="Search job types..." value={jobSearch} onChange={e => setJobSearch(e.target.value)} style={input} />
              <select value={jobTypeId} onChange={e => {
                setJobTypeId(e.target.value)
                const j = JOB_CATALOG.find(x => x.id === e.target.value)
                if (j) {
                  setRateType(j.defaultRateType)
                  if (j.defaultRateType === 'flat') setFlatAmount(String(j.defaultRate))
                  else setHourlyRate(String(j.defaultRate))
                }
              }} style={input}>
                {filteredJobs.map(j => <option key={j.id} value={j.id}>{j.name} — {j.category}</option>)}
              </select>
            </div>
            <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
              {filteredJobs.length} of {JOB_CATALOG.length} jobs · Selected: <strong>{selectedJob.name}</strong> (default ${selectedJob.defaultRate}/{selectedJob.unit})
            </p>

            <label style={label}>Describe the job</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} style={{ ...input, fontFamily: 'inherit' }} placeholder="Details that go into the customer-facing scope of work..." />
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '16px' }}>Pricing — Flat Rate or Hourly</h3>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
              <button onClick={() => setRateType('flat')} style={{ flex: 1, padding: '12px', border: rateType === 'flat' ? '2px solid #f97316' : '1px solid #e2e8f0', background: rateType === 'flat' ? '#fff7ed' : 'white', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
                Flat Rate
              </button>
              <button onClick={() => setRateType('hourly')} style={{ flex: 1, padding: '12px', border: rateType === 'hourly' ? '2px solid #f97316' : '1px solid #e2e8f0', background: rateType === 'hourly' ? '#fff7ed' : 'white', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
                Hourly Rate
              </button>
            </div>

            {rateType === 'flat' ? (
              <div>
                <label style={label}>Flat Amount ($)</label>
                <input type="number" value={flatAmount} onChange={e => setFlatAmount(e.target.value)} style={input} placeholder="e.g. 12000" />
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                <div>
                  <label style={label}>Hourly Rate ($/hr)</label>
                  <input type="number" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} style={input} placeholder="e.g. 85" />
                </div>
                <div>
                  <label style={label}>Estimated Hours</label>
                  <input type="number" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} style={input} placeholder="e.g. 40" />
                </div>
              </div>
            )}
            <p style={{ marginTop: '12px', fontSize: '14px', color: '#64748b' }}>
              Labor subtotal: <strong style={{ color: '#f97316' }}>${laborTotal.toFixed(2)}</strong>
              {validZip && <> &nbsp;(AI prices for {region})</>}
            </p>
          </div>

          <div style={card}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: includeMaterials ? '16px' : 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeMaterials} onChange={e => setIncludeMaterials(e.target.checked)} />
              <span style={{ fontWeight: 600 }}>Include materials (scan the room)</span>
            </label>
            {includeMaterials && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', alignItems: 'end', marginBottom: '16px' }}>
                  <div><label style={label}>Room Type</label>
                    <select value={roomType} onChange={e => setRoomType(e.target.value)} style={input}>
                      {ROOM_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
                    </select>
                  </div>
                  <div><label style={label}>Length (ft)</label><input type="number" value={roomLength} onChange={e => setRoomLength(e.target.value)} style={input} /></div>
                  <div><label style={label}>Width (ft)</label><input type="number" value={roomWidth} onChange={e => setRoomWidth(e.target.value)} style={input} /></div>
                  <div><label style={label}>Height (ft)</label><input type="number" value={roomHeight} onChange={e => setRoomHeight(e.target.value)} style={input} /></div>
                  <div></div>
                  <button onClick={runMaterialScan} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>Scan</button>
                </div>
                {materialLines.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead><tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                      <th style={{ padding: '8px' }}>Material</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: '8px' }}>Unit</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Unit $</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Subtotal</th>
                    </tr></thead>
                    <tbody>
                      {materialLines.map((m, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px' }}>{m.name}</td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <input type="number" value={m.quantity} onChange={e => updateMaterialQty(i, Number(e.target.value))} style={{ width: '70px', padding: '4px', textAlign: 'right', border: '1px solid #e2e8f0', borderRadius: '4px' }} />
                          </td>
                          <td style={{ padding: '8px' }}>{m.unit}</td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>${m.unitPrice.toFixed(2)}</td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>${(m.quantity * m.unitPrice).toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr><td colSpan={4} style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>Materials Total</td>
                          <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, color: '#f97316' }}>${materialsTotal.toFixed(2)}</td></tr>
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>

          <div style={card}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: includeRentals ? '16px' : 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeRentals} onChange={e => setIncludeRentals(e.target.checked)} />
              <span style={{ fontWeight: 600 }}>Include rental equipment</span>
            </label>
            {includeRentals && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'end', marginBottom: '12px' }}>
                  <div><label style={label}>Equipment</label>
                    <select value={selectedRentalId} onChange={e => setSelectedRentalId(e.target.value)} style={input}>
                      {RENTAL_EQUIPMENT.map(r => <option key={r.id} value={r.id}>{r.name} — ${r.dailyRate}/day</option>)}
                    </select>
                  </div>
                  <div><label style={label}>Days</label>
                    <input type="number" value={rentalDays} onChange={e => setRentalDays(e.target.value)} min={1} style={input} />
                  </div>
                  <button onClick={addRental} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>Add</button>
                </div>
                {rentalLines.map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                    <span>{r.name}</span>
                    <span>{r.days} day(s) × ${r.dailyRate} = <strong>${(r.days * r.dailyRate).toFixed(2)}</strong> (deposit ${r.deposit})</span>
                    <button onClick={() => removeRental(i)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>Remove</button>
                  </div>
                ))}
                {rentalLines.length > 0 && <p style={{ marginTop: '8px', textAlign: 'right', fontWeight: 700 }}>Rentals Total: <span style={{ color: '#f97316' }}>${rentalsTotal.toFixed(2)}</span></p>}
              </>
            )}
          </div>

          <div style={{ ...card, background: '#1a1f2e', color: 'white' }}>
            <h3 style={{ marginBottom: '12px' }}>Quote Summary</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', fontSize: '14px' }}>
              <div><div style={{ color: '#94a3b8' }}>Labor</div><div style={{ fontSize: '18px', fontWeight: 700 }}>${laborTotal.toFixed(2)}</div></div>
              <div><div style={{ color: '#94a3b8' }}>Materials</div><div style={{ fontSize: '18px', fontWeight: 700 }}>${materialsTotal.toFixed(2)}</div></div>
              <div><div style={{ color: '#94a3b8' }}>Rentals</div><div style={{ fontSize: '18px', fontWeight: 700 }}>${rentalsTotal.toFixed(2)}</div></div>
              <div><div style={{ color: '#fb923c' }}>Total Quote</div><div style={{ fontSize: '24px', fontWeight: 700, color: '#f97316' }}>${total.toFixed(2)}</div></div>
            </div>
          </div>

          <div style={{ ...card, border: '2px dashed #a78bfa' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: aiQuote ? '16px' : 0 }}>
              <div>
                <h3 style={{ marginBottom: '4px' }}>🤖 AI Quote Generator</h3>
                <p style={{ color: '#64748b', fontSize: '13px' }}>
                  Generate a full customer-ready quote with waste math, labor breakdown, recommended markup, and contractor notes. Powered by Claude via Firebase Functions — your API key stays on the server.
                </p>
              </div>
              <button
                onClick={runAIGenerator}
                disabled={aiLoading}
                style={{
                  background: '#7c3aed', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '8px',
                  cursor: aiLoading ? 'not-allowed' : 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
                }}
              >
                {aiLoading ? 'Generating…' : aiQuote ? (aiUsedFallback ? 'Retry AI' : 'Regenerate') : 'Generate AI Quote'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '16px', padding: '12px', background: '#faf5ff', borderRadius: '8px' }}>
              <div>
                <label style={label}>Hourly Rate ($/hr)</label>
                <input type="number" value={aiHourlyRate} onChange={e => setAiHourlyRate(e.target.value)} style={input} placeholder="e.g. 65" />
                <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>NC fair-market: $55–$75 solo, $85+ skilled w/ helper</p>
              </div>
              <div>
                <label style={label}>Markup %</label>
                <input type="number" value={aiMarkupPct} onChange={e => setAiMarkupPct(e.target.value)} style={input} placeholder="e.g. 20" />
                <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>Small jobs: 15–20% · Medium: 20–25% · Specialty: 25–35%</p>
              </div>
            </div>

            {aiLoading && aiLoadingMessage && (
              <p style={{ color: '#7c3aed', fontSize: '13px', marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                {aiLoadingMessage}
              </p>
            )}
            {aiUsedFallback && !aiLoading && (
              <p style={{ background: '#fef3c7', color: '#92400e', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginTop: '12px' }}>
                ⚠ <strong>AI was unavailable — showing a calculated quote.</strong> Review materials, labor hours, and markup before sending. Click "Retry AI" to try the AI again.
              </p>
            )}
            {aiError && !aiUsedFallback && <p style={{ color: '#dc2626', fontSize: '13px', marginTop: '8px' }}>⚠ {aiError}</p>}

            {aiQuote && (
              <div style={{ marginTop: '8px', display: 'grid', gap: '14px' }}>
                <div>
                  <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Customer Summary</h4>
                  <p style={{ fontSize: '14px', lineHeight: 1.5 }}>{aiQuote.customer_summary}</p>
                </div>

                <div>
                  <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Work Scope</h4>
                  <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: '12px', borderRadius: '6px', margin: 0 }}>{aiQuote.work_scope}</pre>
                </div>

                {aiQuote.material_list.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Materials (with waste math)</h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginTop: '6px' }}>
                      <thead><tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                        <th style={{ padding: '6px' }}>Material</th>
                        <th style={{ padding: '6px' }}>Math</th>
                        <th style={{ padding: '6px', textAlign: 'right' }}>Qty (+ waste)</th>
                        <th style={{ padding: '6px', textAlign: 'right' }}>Unit $</th>
                        <th style={{ padding: '6px', textAlign: 'right' }}>Total</th>
                      </tr></thead>
                      <tbody>
                        {aiQuote.material_list.map((m, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '6px', fontWeight: 600 }}>{m.name}</td>
                            <td style={{ padding: '6px', color: '#64748b' }}>{m.quantity_math}</td>
                            <td style={{ padding: '6px', textAlign: 'right' }}>{m.quantity_with_waste} {m.unit} <span style={{ color: '#94a3b8' }}>(+{m.waste_percent}%)</span></td>
                            <td style={{ padding: '6px', textAlign: 'right' }}>${m.unit_price.toFixed(2)}</td>
                            <td style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }}>${m.line_total.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
                  <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px' }}>
                    <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>Labor ({aiQuote.labor.estimated_hours}h @ ${aiQuote.labor.hourly_rate}/hr)</h4>
                    <p style={{ fontSize: '13px', color: '#475569', whiteSpace: 'pre-wrap' }}>{aiQuote.labor.breakdown}</p>
                    <p style={{ fontSize: '14px', fontWeight: 700, marginTop: '8px' }}>Labor total: ${aiQuote.labor.labor_total.toFixed(2)}</p>
                  </div>

                  <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px' }}>
                    <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>Profit Markup ({aiQuote.profit_markup.markup_percent}%)</h4>
                    <p style={{ fontSize: '13px', color: '#475569' }}>{aiQuote.profit_markup.rationale}</p>
                    <p style={{ fontSize: '14px', fontWeight: 700, marginTop: '8px' }}>+ ${aiQuote.profit_markup.markup_dollars.toFixed(2)}</p>
                  </div>
                </div>

                <div style={{ background: '#1a1f2e', color: 'white', padding: '16px', borderRadius: '8px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', fontSize: '13px' }}>
                    <div><div style={{ color: '#94a3b8' }}>Labor</div><div style={{ fontWeight: 700 }}>${aiQuote.price_breakdown.labor_subtotal.toFixed(2)}</div></div>
                    <div><div style={{ color: '#94a3b8' }}>Materials</div><div style={{ fontWeight: 700 }}>${aiQuote.price_breakdown.materials_subtotal.toFixed(2)}</div></div>
                    <div><div style={{ color: '#94a3b8' }}>Rentals</div><div style={{ fontWeight: 700 }}>${aiQuote.price_breakdown.rentals_subtotal.toFixed(2)}</div></div>
                    <div><div style={{ color: '#94a3b8' }}>Raw cost</div><div style={{ fontWeight: 700 }}>${aiQuote.price_breakdown.raw_cost.toFixed(2)}</div></div>
                  </div>
                  <hr style={{ border: 'none', borderTop: '1px solid #334155', margin: '12px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#fb923c', fontSize: '13px', fontWeight: 600 }}>Final Customer Quote</span>
                    <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${aiQuote.final_customer_quote.toFixed(2)}</span>
                  </div>
                </div>

                <details>
                  <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#64748b' }}>🔒 Contractor Notes (internal — not shown to customer)</summary>
                  <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#fef3c7', padding: '12px', borderRadius: '6px', marginTop: '8px' }}>{aiQuote.contractor_notes}</pre>
                </details>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
            <button onClick={handleSubmit} disabled={loading} style={{ background: '#f97316', color: 'white', border: 'none', padding: '12px 28px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
              {loading ? 'Saving...' : aiQuote ? 'Save Estimate (with AI quote)' : 'Save Estimate'}
            </button>
            <button onClick={() => { setShowForm(false); resetForm() }} style={{ background: '#f1f5f9', border: 'none', padding: '12px 28px', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
          </div>
        </>
      )}

      {selectedEstimate && (
        <div style={{ ...card, border: '2px solid #f97316' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '22px', fontWeight: 700 }}>{selectedEstimate.customerName}</h2>
              <p style={{ color: '#64748b', fontSize: '14px' }}>{selectedEstimate.jobTypeName} · {selectedEstimate.jobLocationZip} ({selectedEstimate.jobLocationRegion}) · {new Date(selectedEstimate.createdAt).toLocaleDateString()}</p>
              <p style={{ color: '#f97316', fontWeight: 700, fontSize: '28px', marginTop: '4px' }}>${(selectedEstimate.total || 0).toFixed(2)}</p>
            </div>
            <button onClick={() => setSelectedId(null)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: '#64748b' }}>×</button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button onClick={() => setStatus(selectedEstimate.id, 'approved')} disabled={selectedEstimate.status === 'approved'}
              style={{ background: selectedEstimate.status === 'approved' ? '#16a34a' : '#f0fdf4', color: selectedEstimate.status === 'approved' ? 'white' : '#16a34a', border: '1px solid #16a34a', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              ✓ Approve
            </button>
            <button onClick={() => setStatus(selectedEstimate.id, 'declined')} disabled={selectedEstimate.status === 'declined'}
              style={{ background: selectedEstimate.status === 'declined' ? '#dc2626' : '#fef2f2', color: selectedEstimate.status === 'declined' ? 'white' : '#dc2626', border: '1px solid #dc2626', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              ✕ Decline
            </button>
            <button onClick={() => setStatus(selectedEstimate.id, 'pending')} disabled={selectedEstimate.status === 'pending'}
              style={{ background: selectedEstimate.status === 'pending' ? '#ea580c' : '#fff7ed', color: selectedEstimate.status === 'pending' ? 'white' : '#ea580c', border: '1px solid #ea580c', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              ↻ Reset to Pending
            </button>
            <button onClick={() => printEstimate(selectedEstimate)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, marginLeft: 'auto' }}>
              🖨️ Print / PDF
            </button>
          </div>

          {selectedEstimate.aiQuote ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <div>
                <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Customer Summary</h4>
                <p style={{ fontSize: '14px', lineHeight: 1.5 }}>{selectedEstimate.aiQuote.customer_summary}</p>
              </div>
              <div>
                <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Work Scope</h4>
                <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: '12px', borderRadius: '6px', margin: 0 }}>{selectedEstimate.aiQuote.work_scope}</pre>
              </div>
              <details>
                <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#64748b' }}>🔒 Contractor Notes (internal)</summary>
                <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#fef3c7', padding: '12px', borderRadius: '6px', marginTop: '8px' }}>{selectedEstimate.aiQuote.contractor_notes}</pre>
              </details>
            </div>
          ) : (
            <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: '12px', borderRadius: '6px' }}>{selectedEstimate.scopeOfWork}</pre>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {estimates.length === 0 && !showForm && <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: '48px' }}>No estimates yet. Create your first one!</p>}
        {estimates.map(e => {
          const sc = statusColor(e.status)
          return (
            <div key={e.id} onClick={() => setSelectedId(e.id === selectedId ? null : e.id)} style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer', border: e.id === selectedId ? '2px solid #f97316' : '2px solid transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <h3 style={{ fontWeight: 600, marginBottom: '4px' }}>{e.customerName}</h3>
                  <p style={{ color: '#64748b', fontSize: '14px' }}>{e.jobTypeName} {e.jobLocationZip && `· ${e.jobLocationZip} (${e.jobLocationRegion})`}</p>
                  <p style={{ color: '#f97316', fontWeight: 700, fontSize: '20px', marginTop: '4px' }}>${(e.total || 0).toFixed(2)}</p>
                  <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>{e.rateType === 'flat' ? `Flat: $${e.flatAmount}` : `${e.estimatedHours}h × $${e.hourlyRate}/hr`}{e.materials?.length ? ` · ${e.materials.length} materials` : ''}{e.rentals?.length ? ` · ${e.rentals.length} rentals` : ''}</p>
                </div>
                <span style={{ background: sc.bg, color: sc.color, padding: '4px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>{e.status}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
