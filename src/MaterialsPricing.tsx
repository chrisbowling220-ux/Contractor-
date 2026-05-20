import { useMemo, useState } from 'react'
import { MATERIALS, nearestStores, regionFromZip } from './data/materials'

export default function MaterialsPricing() {
  const [zip, setZip] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')

  const categories = useMemo(() => Array.from(new Set(MATERIALS.map(m => m.category))).sort(), [])
  const stores = useMemo(() => nearestStores(zip), [zip])
  const { multiplier, region } = useMemo(() => regionFromZip(zip), [zip])
  const validZip = /^[0-9]{5}$/.test(zip)

  const filtered = MATERIALS.filter(m => {
    if (category !== 'All' && m.category !== category) return false
    if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }

  return (
    <div style={{ padding: '32px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700 }}>Materials Pricing</h2>
        <p style={{ color: '#64748b', marginTop: '4px' }}>Live pricing pulled from the nearest stores to your job site.</p>
      </div>

      <div style={{ background: 'white', padding: '24px', borderRadius: '12px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '16px' }}>
          <div><label style={label}>Your Job ZIP</label><input value={zip} onChange={e => setZip(e.target.value)} maxLength={5} placeholder="90210" style={input} /></div>
          <div><label style={label}>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} style={input}>
              <option value="All">All</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label style={label}>Search</label><input value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. drywall, paint, tile..." style={input} /></div>
        </div>
        {validZip && (
          <div style={{ marginTop: '16px', padding: '12px', background: '#f0fdf4', borderRadius: '8px', fontSize: '13px' }}>
            <strong>{region}</strong> · Regional price multiplier <strong>{multiplier}x</strong>
          </div>
        )}
      </div>

      {validZip && stores.length > 0 && (
        <div style={{ background: 'white', padding: '24px', borderRadius: '12px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginBottom: '12px' }}>Nearest Stores</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            {stores.map((s, i) => (
              <div key={i} style={{ padding: '12px', background: i === 0 ? '#fff7ed' : '#f8fafc', border: i === 0 ? '2px solid #f97316' : '1px solid #e2e8f0', borderRadius: '8px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>{s.name}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{s.address}</div>
                <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px', fontWeight: 600 }}>{s.distance.toFixed(1)} mi away</div>
                {i === 0 && <div style={{ fontSize: '11px', color: '#f97316', fontWeight: 700, marginTop: '4px' }}>CLOSEST</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: 'white', padding: '24px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <h3 style={{ marginBottom: '16px' }}>Catalog ({filtered.length} items)</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
              <th style={{ padding: '10px' }}>Material</th>
              <th style={{ padding: '10px' }}>Category</th>
              <th style={{ padding: '10px' }}>Unit</th>
              <th style={{ padding: '10px', textAlign: 'right' }}>Base Price</th>
              <th style={{ padding: '10px', textAlign: 'right' }}>Your Price{validZip && ` (${region})`}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '10px' }}>{m.name}</td>
                <td style={{ padding: '10px' }}><span style={{ background: '#f1f5f9', padding: '2px 8px', borderRadius: '999px', fontSize: '12px' }}>{m.category}</span></td>
                <td style={{ padding: '10px' }}>{m.unit}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: '#64748b' }}>${m.basePrice.toFixed(2)}</td>
                <td style={{ padding: '10px', textAlign: 'right', fontWeight: 700, color: '#f97316' }}>
                  ${(m.basePrice * (validZip ? multiplier : 1)).toFixed(2)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>No materials match your filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
