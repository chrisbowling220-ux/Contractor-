import { useState, useEffect } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, where, doc, deleteDoc } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'
import CustomerDetail from './CustomerDetail'

interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
  createdAt: string
}

export default function Customers() {
  const { user } = useUser()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' })
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const fetchCustomers = async () => {
    if (!user?.id) { setCustomers([]); return }
    try {
      const q = query(collection(db, 'customers'), where('createdBy', '==', user.id))
      const snapshot = await getDocs(q)
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Customer))
      list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      setCustomers(list)
    } catch (err) {
      console.error('Customers fetch failed:', err)
      setCustomers([])
    }
  }

  useEffect(() => { fetchCustomers() }, [user?.id])

  const deleteCustomer = async (id: string, name: string) => {
    if (!confirm(`Delete customer "${name}"? Existing estimates linked to them stay, but the customer record is removed. This cannot be undone.`)) return
    try {
      await deleteDoc(doc(db, 'customers', id))
      setCustomers(customers.filter(c => c.id !== id))
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { alert('Please enter a customer name.'); return }
    if (!user?.id) { alert('Not signed in.'); return }
    setLoading(true)
    try {
      await addDoc(collection(db, 'customers'), {
        name: form.name.trim(),
        phone: form.phone || '',
        email: form.email || '',
        address: form.address || '',
        createdBy: user.id,
        createdAt: new Date().toISOString()
      })
      setForm({ name: '', phone: '', email: '', address: '' })
      setShowForm(false)
      await fetchCustomers()
    } catch (err) {
      console.error('Customer save failed:', err)
      alert('Could not save the customer: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  const activeCustomer = activeId ? customers.find(c => c.id === activeId) : null
  if (activeCustomer) {
    return <CustomerDetail customer={activeCustomer} onBack={() => setActiveId(null)} />
  }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: '#1a1f2e', letterSpacing: '-0.5px' }}>👥 Customers</h2>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>{customers.length === 0 ? 'Add your first customer to start tracking jobs.' : `${customers.length} customer${customers.length === 1 ? '' : 's'} · Tap any to open their photo log.`}</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '12px 22px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 700, boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}>
          {showForm ? '✕ Cancel' : '+ Add Customer'}
        </button>
      </div>

      {showForm && (
        <div style={{ background: 'white', padding: '24px', borderRadius: '12px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginBottom: '16px' }}>New Customer</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
            <input placeholder="Full Name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
            <input placeholder="Phone Number" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
            <input placeholder="Email Address" value={form.email} onChange={e => setForm({...form, email: e.target.value})} style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
            <input placeholder="Job Address" value={form.address} onChange={e => setForm({...form, address: e.target.value})} style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
          </div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '12px' }}>
            <button onClick={handleSubmit} disabled={loading} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
              {loading ? 'Saving...' : 'Save Customer'}
            </button>
            <button onClick={() => setShowForm(false)} style={{ background: '#f1f5f9', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {customers.length === 0 && <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: '48px' }}>No customers yet. Add your first one!</p>}
        {customers.map(c => (
          <div key={c.id} onClick={() => setActiveId(c.id)} style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', cursor: 'pointer', border: '2px solid transparent', transition: 'border-color 0.1s' }}
            onMouseOver={e => (e.currentTarget.style.borderColor = '#f97316')}
            onMouseOut={e => (e.currentTarget.style.borderColor = 'transparent')}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ fontWeight: '600', marginBottom: '4px' }}>{c.name}</h3>
              <p style={{ color: '#64748b', fontSize: '14px' }}>{c.phone} {c.email && `· ${c.email}`}</p>
              {c.address && <p style={{ color: '#94a3b8', fontSize: '13px' }}>{c.address}</p>}
              <p style={{ color: '#0ea5e9', fontSize: '12px', marginTop: '6px', fontWeight: 600 }}>📸 Click to open photo log →</p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
              <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '4px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: '600' }}>Active</span>
              <button onClick={() => deleteCustomer(c.id, c.name)} style={{ background: 'transparent', color: '#dc2626', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                🗑️ Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
