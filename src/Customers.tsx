import { useEffect, useMemo, useState } from 'react'
import { db } from './firebase'
import { collection, addDoc, query, where, doc, deleteDoc, updateDoc, onSnapshot } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'
import CustomerDetail from './CustomerDetail'
import { contactLinks, matchesCustomerSearch } from './lib/customers'
import type { Customer } from './lib/customers'

const EMPTY = { name: '', phone: '', email: '', address: '', notes: '' }

export default function Customers() {
  const { user } = useUser()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loaded, setLoaded] = useState(false)
  // null = form closed, 'new' = adding, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

  // Live list, newest first.
  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(
      query(collection(db, 'customers'), where('createdBy', '==', user.id)),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer))
        list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        setCustomers(list)
        setLoaded(true)
      },
      err => { console.error('Customers listener failed:', err); setLoaded(true) },
    )
    return () => unsub()
  }, [user?.id])

  const flash = (msg: string) => { setNotice(msg); window.setTimeout(() => setNotice(''), 3500) }

  const openNew = () => { setForm(EMPTY); setFormError(''); setEditing('new') }
  const openEdit = (c: Customer) => {
    setForm({ name: c.name || '', phone: c.phone || '', email: c.email || '', address: c.address || '', notes: c.notes || '' })
    setFormError('')
    setEditing(c.id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const closeForm = () => { setEditing(null); setFormError('') }

  const deleteCustomer = async (c: Customer) => {
    if (!confirm(`Delete customer "${c.name}"? Their estimates, invoices and jobs stay, but the customer record is removed. This cannot be undone.`)) return
    try {
      await deleteDoc(doc(db, 'customers', c.id))
      flash(`Deleted ${c.name}.`)
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleSubmit = async () => {
    const name = form.name.trim()
    const email = form.email.trim()
    if (!name) { setFormError('Enter the customer\'s name.'); return }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFormError('That email address doesn\'t look right. Fix it or leave it blank.'); return }
    if (!user?.id) { setFormError('You are signed out. Sign in again to save.'); return }
    const duplicate = customers.find(c => c.id !== editing && c.name.trim().toLowerCase() === name.toLowerCase())
    if (duplicate && !confirm(`You already have a customer named "${duplicate.name}". Save another one with the same name?`)) return
    setSaving(true)
    setFormError('')
    const fields = { name, phone: form.phone.trim(), email, address: form.address.trim(), notes: form.notes.trim() }
    try {
      if (editing && editing !== 'new') {
        await updateDoc(doc(db, 'customers', editing), { ...fields, updatedAt: new Date().toISOString() })
        flash(`Saved changes to ${name}.`)
      } else {
        await addDoc(collection(db, 'customers'), { ...fields, createdBy: user.id, createdAt: new Date().toISOString() })
        flash(`Added ${name}.`)
      }
      setForm(EMPTY)
      setEditing(null)
    } catch (err) {
      console.error('Customer save failed:', err)
      setFormError('Could not save: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const shown = useMemo(() => customers.filter(c => matchesCustomerSearch(c, search)), [customers, search])

  const activeCustomer = activeId ? customers.find(c => c.id === activeId) : null
  if (activeCustomer) {
    return <CustomerDetail customer={activeCustomer} onBack={() => setActiveId(null)} onEdit={() => { setActiveId(null); openEdit(activeCustomer) }} />
  }

  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 700, color: '#475569', marginBottom: '4px' }
  const field: React.CSSProperties = { width: '100%', padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '16px', boxSizing: 'border-box', fontFamily: 'inherit' }
  const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: '44px', padding: '0 14px', borderRadius: '8px', border: '1px solid #cbd5e1', background: 'white', color: '#1a1f2e', fontWeight: 600, fontSize: '14px', textDecoration: 'none', cursor: 'pointer' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: '#1a1f2e', letterSpacing: '-0.5px' }}>👥 Customers</h2>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>
            {!loaded ? 'Loading…' : customers.length === 0 ? 'Add your first customer to start tracking jobs.' : `${customers.length} customer${customers.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <button onClick={() => editing ? closeForm() : openNew()} style={{ background: '#f97316', color: 'white', border: 'none', padding: '12px 22px', borderRadius: '8px', cursor: 'pointer', fontSize: '15px', fontWeight: 700, minHeight: '48px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}>
          {editing ? '✕ Cancel' : '+ Add Customer'}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {notice && <p style={{ margin: '0 0 12px', padding: '10px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', color: '#15803d', fontWeight: 600, fontSize: '14px' }}>✓ {notice}</p>}
      </div>

      {editing && (
        <div style={{ background: 'white', padding: 'clamp(16px, 4vw, 24px)', borderRadius: '12px', marginBottom: '20px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)' }}>
          <h3 style={{ margin: '0 0 14px' }}>{editing === 'new' ? 'New customer' : 'Edit customer'}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
            <div>
              <label style={label} htmlFor="cust-name">Full name *</label>
              <input id="cust-name" autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={field} />
            </div>
            <div>
              <label style={label} htmlFor="cust-phone">Phone</label>
              <input id="cust-phone" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={field} />
            </div>
            <div>
              <label style={label} htmlFor="cust-email">Email</label>
              <input id="cust-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={field} />
            </div>
            <div>
              <label style={label} htmlFor="cust-address">Job address</label>
              <input id="cust-address" autoComplete="street-address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} style={field} />
            </div>
          </div>
          <div style={{ marginTop: '14px' }}>
            <label style={label} htmlFor="cust-notes">Notes (only you see these)</label>
            <textarea id="cust-notes" rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Gate code, dog in the yard, prefers texts after 5…" style={{ ...field, resize: 'vertical' }} />
          </div>
          {formError && <p role="alert" style={{ margin: '12px 0 0', color: '#b91c1c', fontWeight: 600, fontSize: '14px' }}>{formError}</p>}
          <div style={{ marginTop: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button onClick={handleSubmit} disabled={saving} style={{ background: saving ? '#94a3b8' : '#f97316', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px', minHeight: '48px' }}>
              {saving ? 'Saving…' : editing === 'new' ? 'Save customer' : 'Save changes'}
            </button>
            <button onClick={closeForm} style={{ background: '#f1f5f9', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontSize: '15px', minHeight: '48px' }}>Cancel</button>
          </div>
        </div>
      )}

      {customers.length > 0 && (
        <div style={{ position: 'relative', marginBottom: '14px' }}>
          <label htmlFor="cust-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Search customers</label>
          <input id="cust-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, phone, email or address…" style={{ ...field, borderRadius: '10px' }} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {loaded && customers.length === 0 && !editing && <p style={{ color: '#64748b', textAlign: 'center', marginTop: '48px' }}>No customers yet. Tap <strong>+ Add Customer</strong> to add your first one.</p>}
        {customers.length > 0 && shown.length === 0 && <p style={{ color: '#64748b', textAlign: 'center', marginTop: '24px' }}>No customers match “{search}”.</p>}
        {shown.map(c => {
          const links = contactLinks(c)
          return (
            <div key={c.id} style={{ background: 'white', padding: '16px', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)' }}>
              <button onClick={() => setActiveId(c.id)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}>
                <span style={{ display: 'block', fontWeight: 700, fontSize: '17px', color: '#1a1f2e' }}>{c.name}</span>
                {(c.phone || c.email) && <span style={{ display: 'block', color: '#475569', fontSize: '14px', marginTop: '2px' }}>{[c.phone, c.email].filter(Boolean).join(' · ')}</span>}
                {c.address && <span style={{ display: 'block', color: '#64748b', fontSize: '13px', marginTop: '2px' }}>{c.address}</span>}
                {c.notes && <span style={{ display: 'block', color: '#64748b', fontSize: '13px', marginTop: '6px', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{c.notes.length > 140 ? c.notes.slice(0, 140) + '…' : c.notes}</span>}
                <span style={{ display: 'block', color: '#0369a1', fontSize: '13px', marginTop: '8px', fontWeight: 600 }}>Open records, signed documents &amp; photo log →</span>
              </button>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
                {links.call && <a href={links.call} style={chip}>📞 Call</a>}
                {links.text && <a href={links.text} style={chip}>💬 Text</a>}
                {links.email && <a href={links.email} style={chip}>✉️ Email</a>}
                {links.map && <a href={links.map} target="_blank" rel="noopener noreferrer" style={chip}>📍 Directions</a>}
                <button onClick={() => openEdit(c)} style={chip}>✏️ Edit</button>
                <button onClick={() => deleteCustomer(c)} aria-label={`Delete ${c.name}`} style={{ ...chip, color: '#b91c1c', borderColor: '#fecaca', marginLeft: 'auto' }}>🗑️ Delete</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
