import { useState, useEffect } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, where, updateDoc, deleteDoc, doc } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'
import type { Estimate, Project } from './data/types'
import { PROJECT_STATUS_LABEL } from './data/types'

interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
  notes: string
  createdAt: string
}

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

export default function Customers() {
  const { user } = useUser()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [showForm, setShowForm] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [search, setSearch] = useState('')

  const blank = { name: '', phone: '', email: '', address: '', notes: '' }
  const [form, setForm] = useState(blank)

  const load = async () => {
    if (!user?.id) { setCustomers([]); setEstimates([]); setProjects([]); return }
    const own = (col: string) => query(collection(db, col), where('createdBy', '==', user.id))
    const byDate = <T extends { createdAt: string }>(docs: T[]) =>
      docs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    try {
      const [cSnap, eSnap, pSnap] = await Promise.all([getDocs(own('customers')), getDocs(own('estimates')), getDocs(own('projects'))])
      setCustomers(byDate(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Customer))))
      setEstimates(eSnap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate)))
      setProjects(pSnap.docs.map(d => ({ id: d.id, ...d.data() } as Project)))
    } catch (err) { console.error('Customers load error:', err) }
  }
  useEffect(() => { load() }, [user?.id])

  const handleCreate = async () => {
    if (!form.name) return
    setLoading(true)
    await addDoc(collection(db, 'customers'), { ...form, createdBy: user?.id, createdAt: new Date().toISOString() })
    setForm(blank)
    setShowForm(false)
    setLoading(false)
    load()
  }

  const handleUpdate = async () => {
    if (!activeId) return
    setLoading(true)
    await updateDoc(doc(db, 'customers', activeId), { name: form.name, phone: form.phone, email: form.email, address: form.address, notes: form.notes })
    setEditMode(false)
    setLoading(false)
    setCustomers(prev => prev.map(c => c.id === activeId ? { ...c, ...form } : c))
  }

  const handleDelete = async () => {
    if (!activeId) return
    await deleteDoc(doc(db, 'customers', activeId))
    setActiveId(null)
    setDeleteConfirm(false)
    setCustomers(prev => prev.filter(c => c.id !== activeId))
  }

  const activeCustomer = activeId ? customers.find(c => c.id === activeId) ?? null : null
  const customerEstimates = activeCustomer ? estimates.filter(e => e.customerName.toLowerCase() === activeCustomer.name.toLowerCase()) : []
  const customerProjects = activeCustomer ? projects.filter(p => p.customerName.toLowerCase() === activeCustomer.name.toLowerCase()) : []
  const filteredCustomers = customers.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.email || '').toLowerCase().includes(search.toLowerCase()))

  const inp: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

  if (activeCustomer) {
    const totalRevenue = customerEstimates.filter(e => e.status === 'approved').reduce((s, e) => s + e.total, 0)
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
        <button onClick={() => { setActiveId(null); setEditMode(false); setDeleteConfirm(false) }} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', marginBottom: '16px' }}>
          ← Back to Customers
        </button>

        <div style={{ ...card, background: NAVY, color: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editMode ? (
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ ...inp, fontSize: '22px', fontWeight: 700, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', marginBottom: '8px' }} />
              ) : (
                <h2 style={{ fontSize: '28px', fontWeight: 700, margin: 0 }}>{activeCustomer.name}</h2>
              )}
              <p style={{ color: '#94a3b8', marginTop: '4px', fontSize: '13px' }}>Added {new Date(activeCustomer.createdAt).toLocaleDateString()}</p>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: '16px' }}>
              {!editMode && !deleteConfirm && (
                <>
                  <button onClick={() => { setEditMode(true); setForm({ name: activeCustomer.name, phone: activeCustomer.phone || '', email: activeCustomer.email || '', address: activeCustomer.address || '', notes: (activeCustomer as Customer & { notes?: string }).notes || '' }) }} style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
                    Edit
                  </button>
                  <button onClick={() => setDeleteConfirm(true)} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
                    Delete
                  </button>
                </>
              )}
              {editMode && (
                <>
                  <button onClick={handleUpdate} disabled={loading} style={{ background: ORANGE, color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {loading ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditMode(false)} style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
                    Cancel
                  </button>
                </>
              )}
              {deleteConfirm && (
                <>
                  <button onClick={handleDelete} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}>
                    Confirm Delete
                  </button>
                  <button onClick={() => setDeleteConfirm(false)} style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Approved Revenue</p><p style={{ fontSize: '22px', fontWeight: 700, color: ORANGE }}>${totalRevenue.toFixed(0)}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Estimates</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{customerEstimates.length}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Projects</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{customerProjects.length}</p></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
          <div style={card}>
            <h3 style={{ marginBottom: '16px' }}>Contact Info</h3>
            {editMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div><label style={lbl}>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inp} placeholder="555-555-5555" /></div>
                <div><label style={lbl}>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inp} placeholder="name@email.com" /></div>
                <div><label style={lbl}>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} style={inp} placeholder="123 Main St" /></div>
                <div><label style={lbl}>Notes (internal)</label><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} /></div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {activeCustomer.phone ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>PHONE</div>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>{activeCustomer.phone}</div>
                    </div>
                    <a href={`tel:${activeCustomer.phone}`} style={{ background: '#f0fdf4', color: '#16a34a', padding: '6px 12px', borderRadius: '6px', textDecoration: 'none', fontSize: '12px', fontWeight: 600 }}>📞 Call</a>
                  </div>
                ) : <p style={{ color: '#94a3b8', fontSize: '13px' }}>No phone on file</p>}
                {activeCustomer.email ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>EMAIL</div>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>{activeCustomer.email}</div>
                    </div>
                    <a href={`mailto:${activeCustomer.email}`} style={{ background: '#eff6ff', color: '#2563eb', padding: '6px 12px', borderRadius: '6px', textDecoration: 'none', fontSize: '12px', fontWeight: 600 }}>✉ Email</a>
                  </div>
                ) : <p style={{ color: '#94a3b8', fontSize: '13px' }}>No email on file</p>}
                {activeCustomer.address && (
                  <div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>ADDRESS</div>
                    <div style={{ fontSize: '14px' }}>{activeCustomer.address}</div>
                  </div>
                )}
                {(activeCustomer as Customer & { notes?: string }).notes && (
                  <div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>NOTES</div>
                    <div style={{ fontSize: '13px', color: '#64748b', whiteSpace: 'pre-wrap' }}>{(activeCustomer as Customer & { notes?: string }).notes}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Estimates ({customerEstimates.length})</h3>
            {customerEstimates.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: '13px' }}>No estimates yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {customerEstimates.map(e => {
                  const color = e.status === 'approved' ? '#16a34a' : e.status === 'declined' ? '#dc2626' : '#ea580c'
                  return (
                    <div key={e.id} style={{ padding: '10px', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px' }}>{e.jobTypeName}</span>
                        <span style={{ color, fontWeight: 700, fontSize: '14px' }}>${e.total.toFixed(0)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: '12px', color: '#64748b' }}>{new Date(e.createdAt).toLocaleDateString()}</span>
                        <span style={{ fontSize: '11px', fontWeight: 600, color, textTransform: 'capitalize' }}>{e.status}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Projects ({customerProjects.length})</h3>
            {customerProjects.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: '13px' }}>No projects yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {customerProjects.map(p => (
                  <div key={p.id} style={{ padding: '10px', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{p.jobTypeName}</span>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', background: '#e2e8f0', padding: '2px 8px', borderRadius: '999px' }}>{PROJECT_STATUS_LABEL[p.status]}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{new Date(p.createdAt).toLocaleDateString()}{p.jobLocationZip && ` · ${p.jobLocationZip}`}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700 }}>Customers</h2>
        <button onClick={() => setShowForm(!showForm)} style={{ background: ORANGE, color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>
          + Add Customer
        </button>
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by name or email…"
        style={{ ...inp, marginBottom: '20px', maxWidth: '360px' }}
      />

      {showForm && (
        <div style={{ background: 'white', padding: '24px', borderRadius: '12px', marginBottom: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginBottom: '16px' }}>New Customer</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div><label style={lbl}>Full Name *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inp} placeholder="Jane Smith" /></div>
            <div><label style={lbl}>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inp} placeholder="555-555-5555" /></div>
            <div><label style={lbl}>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inp} placeholder="jane@email.com" /></div>
            <div><label style={lbl}>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} style={inp} placeholder="123 Main St" /></div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <label style={lbl}>Notes (internal)</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} placeholder="Anything to remember about this customer..." />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={handleCreate} disabled={loading || !form.name} style={{ background: ORANGE, color: 'white', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              {loading ? 'Saving…' : 'Save Customer'}
            </button>
            <button onClick={() => { setShowForm(false); setForm(blank) }} style={{ background: '#f1f5f9', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {filteredCustomers.length === 0 && (
          <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: '48px' }}>
            {customers.length === 0 ? 'No customers yet. Add your first one!' : 'No customers match your search.'}
          </p>
        )}
        {filteredCustomers.map(c => {
          const cEsts = estimates.filter(e => e.customerName.toLowerCase() === c.name.toLowerCase())
          const cProjs = projects.filter(p => p.customerName.toLowerCase() === c.name.toLowerCase())
          const revenue = cEsts.filter(e => e.status === 'approved').reduce((s, e) => s + e.total, 0)
          return (
            <div
              key={c.id}
              onClick={() => setActiveId(c.id)}
              style={{ background: 'white', padding: '18px 20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '2px solid transparent', transition: 'border-color 0.1s' }}
              onMouseOver={e => (e.currentTarget.style.borderColor = ORANGE)}
              onMouseOut={e => (e.currentTarget.style.borderColor = 'transparent')}
            >
              <div>
                <h3 style={{ fontWeight: 700, fontSize: '15px', marginBottom: '2px' }}>{c.name}</h3>
                <p style={{ color: '#64748b', fontSize: '13px' }}>
                  {[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact info'}
                </p>
                <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>
                  {cEsts.length} estimate{cEsts.length !== 1 ? 's' : ''} · {cProjs.length} project{cProjs.length !== 1 ? 's' : ''}
                  {revenue > 0 && ` · $${revenue.toFixed(0)} approved`}
                </p>
              </div>
              <div style={{ color: '#cbd5e1', fontSize: '18px' }}>›</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
