import { useMemo, useState } from 'react'
import { RENTAL_EQUIPMENT, RENTAL_CATEGORIES } from './data/rentals'

export default function Rentals() {
  const [category, setCategory] = useState('All')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<{ id: string; days: number }[]>([])

  const filtered = RENTAL_EQUIPMENT.filter(r => {
    if (category !== 'All' && r.category !== category) return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const cartLines = useMemo(() => cart.map(c => {
    const r = RENTAL_EQUIPMENT.find(x => x.id === c.id)!
    return { ...r, days: c.days, lineTotal: r.dailyRate * c.days }
  }), [cart])
  const cartSubtotal = cartLines.reduce((s, l) => s + l.lineTotal, 0)
  const cartDeposit = cartLines.reduce((s, l) => s + l.deposit, 0)

  const addToCart = (id: string) => setCart(prev => prev.find(c => c.id === id) ? prev : [...prev, { id, days: 1 }])
  const updateDays = (id: string, days: number) => setCart(prev => prev.map(c => c.id === id ? { ...c, days: Math.max(1, days) } : c))
  const removeFromCart = (id: string) => setCart(prev => prev.filter(c => c.id !== id))

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }

  return (
    <div style={{ padding: '32px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700 }}>Rental Equipment</h2>
        <p style={{ color: '#64748b', marginTop: '4px' }}>Every kind of equipment available to rent for your jobs.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        <div>
          <div style={{ background: 'white', padding: '20px', borderRadius: '12px', marginBottom: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px' }}>
              <div><label style={label}>Category</label>
                <select value={category} onChange={e => setCategory(e.target.value)} style={input}>
                  <option value="All">All Categories</option>
                  {RENTAL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><label style={label}>Search</label><input value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. excavator, scaffold..." style={input} /></div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
            {filtered.map(r => {
              const inCart = cart.find(c => c.id === r.id)
              return (
                <div key={r.id} style={{ background: 'white', padding: '16px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: inCart ? '2px solid #f97316' : '1px solid transparent' }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>{r.name}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>{r.category}</div>
                  <div style={{ fontSize: '13px' }}>
                    <span style={{ color: '#f97316', fontWeight: 700 }}>${r.dailyRate}</span>/day · ${r.weeklyRate}/wk
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>Deposit ${r.deposit}</div>
                  <button onClick={() => inCart ? removeFromCart(r.id) : addToCart(r.id)} style={{ width: '100%', background: inCart ? '#fef2f2' : '#f97316', color: inCart ? '#dc2626' : 'white', border: 'none', padding: '6px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {inCart ? 'Remove' : '+ Add to Job'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div>
          <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', position: 'sticky', top: '16px' }}>
            <h3 style={{ marginBottom: '12px' }}>Rental Cart</h3>
            {cartLines.length === 0 && <p style={{ color: '#94a3b8', fontSize: '13px' }}>No equipment added yet.</p>}
            {cartLines.map(l => (
              <div key={l.id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{l.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  <input type="number" value={l.days} onChange={e => updateDays(l.id, Number(e.target.value))} min={1} style={{ width: '60px', padding: '4px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px' }} />
                  <span style={{ fontSize: '12px', color: '#64748b' }}>days × ${l.dailyRate} = <strong>${l.lineTotal.toFixed(2)}</strong></span>
                </div>
                <button onClick={() => removeFromCart(l.id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '11px', marginTop: '4px', padding: 0 }}>Remove</button>
              </div>
            ))}
            {cartLines.length > 0 && (
              <div style={{ marginTop: '12px', padding: '12px', background: '#f8fafc', borderRadius: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}><span>Rental Total</span><strong>${cartSubtotal.toFixed(2)}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#64748b', marginTop: '4px' }}><span>Deposit</span><span>${cartDeposit.toFixed(2)}</span></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
