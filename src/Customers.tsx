import { useState, useEffect } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, orderBy, where } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'

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

  const fetchCustomers = async () => {
    if (!user?.id) { setCustomers([]); return }
    const q = query(
      collection(db, 'customers'),
      where('createdBy', '==', user.id),
      orderBy('createdAt', 'desc'),
    )
    const snapshot = await getDocs(q)
    const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Customer))
    setCustomers(list)
  }

  useEffect(() => { fetchCustomers() }, [user?.id])

  const handleSubmit = async () => {
    if (!form.name) return
    setLoading(true)
    await addDoc(collection(db, 'customers'), {
      ...form,
      createdBy: user?.id,
      createdAt: new Date().toISOString()
    })
    setForm({ name: '', phone: '', email: '', address: '' })
    setShowForm(false)
    setLoading(false)
    fetchCustomers()
  }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700' }}>Customers</h2>
        <button onClick={() => setShowForm(!showForm)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: '600' }}>
          + Add Customer
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
          <div key={c.id} style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontWeight: '600', marginBottom: '4px' }}>{c.name}</h3>
              <p style={{ color: '#64748b', fontSize: '14px' }}>{c.phone} {c.email && `· ${c.email}`}</p>
              {c.address && <p style={{ color: '#94a3b8', fontSize: '13px' }}>{c.address}</p>}
            </div>
            <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '4px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: '600' }}>Active</span>
          </div>
        ))}
      </div>
    </div>
  )
}
