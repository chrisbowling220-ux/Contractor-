import { useEffect, useMemo, useState } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, orderBy, updateDoc, doc, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { useUser, useAuth } from '@clerk/clerk-react'
import { JOB_CATALOG } from './data/jobCatalog'
import type { Estimate, Project, ProjectStatus, ChangeOrder, Invoice } from './data/types'
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_ORDER } from './data/types'

interface Customer { id: string; name: string; phone: string; email: string; address: string }
interface PortfolioItem { id: string; title: string; afterUrl: string; createdAt: string }

const STATUS_COLOR: Record<ProjectStatus, { bg: string; text: string }> = {
  lead: { bg: '#f1f5f9', text: '#64748b' },
  estimated: { bg: '#fef3c7', text: '#d97706' },
  contracted: { bg: '#dbeafe', text: '#2563eb' },
  in_progress: { bg: '#fff7ed', text: '#ea580c' },
  completed: { bg: '#f0fdf4', text: '#16a34a' },
  closed: { bg: '#1a1f2e', text: '#cbd5e1' },
}

const sendCoEmailFn = httpsCallable<
  { clerkToken: string; input: { to: string; fromName?: string; replyTo?: string; changeOrder: { customerName: string; jobTypeName: string; description: string; additionalAmount: number; newTotal: number } } },
  { ok: boolean }
>(functions, 'sendChangeOrderEmail')

const sendCoSmsFn = httpsCallable<
  { clerkToken: string; input: { to: string; fromName?: string; changeOrder: { customerName: string; jobTypeName: string; description: string; additionalAmount: number; newTotal: number } } },
  { ok: boolean }
>(functions, 'sendChangeOrderSms')

const sendInvEmailFn = httpsCallable<
  { clerkToken: string; input: { to: string; fromName?: string; replyTo?: string; invoice: { customerName: string; jobTypeName: string; invoiceType: string; amount: number; description: string; dueDate?: string } } },
  { ok: boolean }
>(functions, 'sendInvoiceEmail')

const sendInvSmsFn = httpsCallable<
  { clerkToken: string; input: { to: string; fromName?: string; invoice: { customerName: string; jobTypeName: string; invoiceType: string; amount: number; description: string; dueDate?: string } } },
  { ok: boolean }
>(functions, 'sendInvoiceSms')

export default function Projects() {
  const { user } = useUser()
  const { getToken } = useAuth()

  const [projects, setProjects] = useState<Project[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])

  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>('all')

  const [customerName, setCustomerName] = useState('')
  const [jobTypeName, setJobTypeName] = useState(JOB_CATALOG[0].name)
  const [jobLocationZip, setJobLocationZip] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')

  // Change order form state
  const [showCoForm, setShowCoForm] = useState(false)
  const [coDescription, setCoDescription] = useState('')
  const [coAmount, setCoAmount] = useState('')
  const [coNotes, setCoNotes] = useState('')
  const [coLoading, setCoLoading] = useState(false)

  // Invoice form state
  const [showInvForm, setShowInvForm] = useState(false)
  const [invType, setInvType] = useState<'deposit' | 'milestone' | 'final'>('deposit')
  const [invAmount, setInvAmount] = useState('')
  const [invDescription, setInvDescription] = useState('')
  const [invDueDate, setInvDueDate] = useState('')
  const [invNotes, setInvNotes] = useState('')
  const [invLoading, setInvLoading] = useState(false)

  // Notification state
  const [notifTarget, setNotifTarget] = useState<{ type: 'co' | 'inv'; id: string; channel: 'email' | 'sms' } | null>(null)
  const [notifAddress, setNotifAddress] = useState('')
  const [notifSending, setNotifSending] = useState(false)
  const [notifSent, setNotifSent] = useState<Set<string>>(new Set())
  const [notifError, setNotifError] = useState('')

  const load = async () => {
    if (!user?.id) {
      setProjects([]); setCustomers([]); setEstimates([]); setChangeOrders([]); setInvoices([]); setPortfolio([])
      return
    }
    const own = (name: string) => query(
      collection(db, name),
      where('createdBy', '==', user.id),
      orderBy('createdAt', 'desc'),
    )
    try {
      const [pSnap, cSnap, eSnap, coSnap, invSnap, poSnap] = await Promise.all([
        getDocs(own('projects')),
        getDocs(own('customers')),
        getDocs(own('estimates')),
        getDocs(own('changeOrders')),
        getDocs(own('invoices')),
        getDocs(own('portfolio')),
      ])
      setProjects(pSnap.docs.map(d => ({ id: d.id, ...d.data() } as Project)))
      setCustomers(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)))
      setEstimates(eSnap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate)))
      setChangeOrders(coSnap.docs.map(d => ({ id: d.id, ...d.data() } as ChangeOrder)))
      setInvoices(invSnap.docs.map(d => ({ id: d.id, ...d.data() } as Invoice)))
      setPortfolio(poSnap.docs.map(d => ({ id: d.id, ...d.data() } as PortfolioItem)))
    } catch {}
  }
  useEffect(() => { load() }, [user?.id])

  const save = async () => {
    if (!customerName) return
    setLoading(true)
    const payload: Omit<Project, 'id'> = {
      customerName,
      customerId: customers.find(c => c.name === customerName)?.id,
      jobTypeName,
      jobLocationZip,
      description,
      status: 'lead',
      notes,
      createdAt: new Date().toISOString(),
      createdBy: user?.id,
    }
    try { await addDoc(collection(db, 'projects'), payload) } catch {}
    setCustomerName(''); setJobLocationZip(''); setDescription(''); setNotes('')
    setShowForm(false)
    setLoading(false)
    load()
  }

  const advance = async (p: Project, status: ProjectStatus) => {
    try { await updateDoc(doc(db, 'projects', p.id), { status }) } catch {}
    setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status } : x))
  }

  const updateCoStatus = async (coId: string, status: 'approved' | 'declined') => {
    await updateDoc(doc(db, 'changeOrders', coId), { status })
    load()
  }

  const markInvoicePaid = async (invId: string) => {
    await updateDoc(doc(db, 'invoices', invId), { status: 'paid', paidAt: new Date().toISOString() })
    load()
  }

  const saveChangeOrder = async (p: Project) => {
    if (!coDescription || !coAmount) return
    setCoLoading(true)
    const agg = aggregateForProject(p)
    const newTotal = (agg.contractTotal || agg.quoteTotal || 0) + Number(coAmount)
    await addDoc(collection(db, 'changeOrders'), {
      projectId: p.id,
      customerName: p.customerName,
      jobTypeName: p.jobTypeName,
      description: coDescription,
      additionalAmount: Number(coAmount),
      newTotal,
      notes: coNotes,
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdBy: user?.id,
    })
    setCoDescription(''); setCoAmount(''); setCoNotes(''); setShowCoForm(false); setCoLoading(false)
    load()
  }

  const saveInvoice = async (p: Project) => {
    if (!invAmount || !invDescription) return
    setInvLoading(true)
    await addDoc(collection(db, 'invoices'), {
      projectId: p.id,
      customerName: p.customerName,
      jobTypeName: p.jobTypeName,
      invoiceType: invType,
      amount: Number(invAmount),
      description: invDescription,
      dueDate: invDueDate || undefined,
      notes: invNotes || undefined,
      status: 'draft',
      createdAt: new Date().toISOString(),
      createdBy: user?.id,
    })
    setInvAmount(''); setInvDescription(''); setInvDueDate(''); setInvNotes(''); setShowInvForm(false); setInvLoading(false)
    load()
  }

  const sendNotification = async (type: 'co' | 'inv', item: ChangeOrder | Invoice) => {
    if (!notifTarget || !notifAddress) return
    setNotifSending(true); setNotifError('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const key = `${type}-${item.id}-${notifTarget.channel}`
      if (type === 'co') {
        const co = item as ChangeOrder
        if (notifTarget.channel === 'email') {
          await sendCoEmailFn({ clerkToken, input: { to: notifAddress, changeOrder: { customerName: co.customerName, jobTypeName: co.jobTypeName, description: co.description, additionalAmount: co.additionalAmount, newTotal: co.newTotal } } })
        } else {
          await sendCoSmsFn({ clerkToken, input: { to: notifAddress, changeOrder: { customerName: co.customerName, jobTypeName: co.jobTypeName, description: co.description, additionalAmount: co.additionalAmount, newTotal: co.newTotal } } })
        }
      } else {
        const inv = item as Invoice
        if (notifTarget.channel === 'email') {
          await sendInvEmailFn({ clerkToken, input: { to: notifAddress, invoice: { customerName: inv.customerName, jobTypeName: inv.jobTypeName, invoiceType: inv.invoiceType, amount: inv.amount, description: inv.description, dueDate: inv.dueDate } } })
        } else {
          await sendInvSmsFn({ clerkToken, input: { to: notifAddress, invoice: { customerName: inv.customerName, jobTypeName: inv.jobTypeName, invoiceType: inv.invoiceType, amount: inv.amount, description: inv.description, dueDate: inv.dueDate } } })
        }
      }
      setNotifSent(prev => new Set([...prev, key]))
      setNotifTarget(null); setNotifAddress('')
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : 'Send failed. Please try again.')
    } finally {
      setNotifSending(false)
    }
  }

  const aggregateForProject = (p: Project) => {
    const matchByName = (s: string) => s.toLowerCase() === p.customerName.toLowerCase()
    const ests = estimates.filter(e => matchByName(e.customerName) && e.jobTypeName === p.jobTypeName)
    const cos = changeOrders.filter(c => c.projectId === p.id)
    const invs = invoices.filter(i => i.projectId === p.id)
    const photos = portfolio.filter(po => matchByName(po.title))
    const quoteTotal = ests.reduce((s, e) => s + e.total, 0)
    const coDelta = cos.reduce((s, c) => s + (c.newTotal - (ests[0]?.total ?? 0)), 0)
    const contractTotal = quoteTotal + (cos.length ? coDelta : 0)
    return { ests, cos, invs, photos, quoteTotal, contractTotal }
  }

  const filtered = useMemo(() => statusFilter === 'all' ? projects : projects.filter(p => p.status === statusFilter), [projects, statusFilter])
  const activeProject = activeId ? projects.find(p => p.id === activeId) ?? null : null
  const activeAgg = activeProject ? aggregateForProject(activeProject) : null

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

  const statusBadgeStyle = (status: string): React.CSSProperties => {
    const map: Record<string, { bg: string; color: string }> = {
      pending: { bg: '#fef3c7', color: '#d97706' },
      approved: { bg: '#f0fdf4', color: '#16a34a' },
      declined: { bg: '#fef2f2', color: '#dc2626' },
      draft: { bg: '#f1f5f9', color: '#64748b' },
      sent: { bg: '#dbeafe', color: '#2563eb' },
      paid: { bg: '#f0fdf4', color: '#16a34a' },
      overdue: { bg: '#fef2f2', color: '#dc2626' },
    }
    const s = map[status] ?? { bg: '#f1f5f9', color: '#64748b' }
    return { background: s.bg, color: s.color, padding: '2px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const }
  }

  const openNotif = (type: 'co' | 'inv', id: string, channel: 'email' | 'sms') => {
    setNotifTarget({ type, id, channel })
    setNotifAddress('')
    setNotifError('')
  }

  if (activeProject && activeAgg) {
    const sc = STATUS_COLOR[activeProject.status]
    const customer = customers.find(c => c.name === activeProject.customerName)
    const idx = PROJECT_STATUS_ORDER.indexOf(activeProject.status)
    const nextStatus = PROJECT_STATUS_ORDER[idx + 1]
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
        <button onClick={() => setActiveId(null)} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', marginBottom: '16px' }}>← Back to Projects</button>

        <div style={{ ...card, background: '#1a1f2e', color: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>{activeProject.jobTypeName}</div>
              <h2 style={{ fontSize: '28px', fontWeight: 700, marginTop: '4px' }}>{activeProject.customerName}</h2>
              <p style={{ color: '#cbd5e1', marginTop: '4px' }}>{activeProject.description || '—'}</p>
              {activeProject.jobLocationZip && <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '4px' }}>📍 ZIP {activeProject.jobLocationZip}</p>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ background: sc.bg, color: sc.text, padding: '6px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' }}>{PROJECT_STATUS_LABEL[activeProject.status]}</span>
              {nextStatus && (
                <button onClick={() => advance(activeProject, nextStatus)} style={{ display: 'block', marginTop: '12px', background: '#f97316', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>
                  Advance to {PROJECT_STATUS_LABEL[nextStatus]} →
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '20px', overflowX: 'auto' }}>
            {PROJECT_STATUS_ORDER.map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, background: i <= idx ? '#f97316' : '#334155', color: 'white' }}>
                  {PROJECT_STATUS_LABEL[s]}
                </div>
                {i < PROJECT_STATUS_ORDER.length - 1 && <span style={{ color: i < idx ? '#f97316' : '#475569' }}>→</span>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Contract Total</p><p style={{ fontSize: '22px', fontWeight: 700, color: '#f97316' }}>${activeAgg.contractTotal.toFixed(2)}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Estimates</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{activeAgg.ests.length}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Change Orders</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{activeAgg.cos.length}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Invoices</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{activeAgg.invs.length}</p></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Customer</h3>
            {customer ? (
              <>
                <p style={{ fontWeight: 600 }}>{customer.name}</p>
                {customer.phone && <p style={{ color: '#64748b', fontSize: '14px' }}>{customer.phone}</p>}
                {customer.email && <p style={{ color: '#64748b', fontSize: '14px' }}>{customer.email}</p>}
                {customer.address && <p style={{ color: '#64748b', fontSize: '14px' }}>{customer.address}</p>}
              </>
            ) : <p style={{ color: '#94a3b8', fontSize: '13px' }}>Customer "{activeProject.customerName}" not found in customer list — add them on the Customers page.</p>}
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Estimates ({activeAgg.ests.length})</h3>
            {activeAgg.ests.length === 0 && <p style={{ color: '#94a3b8', fontSize: '13px' }}>No estimates yet. Create one on the Estimates page using customer "{activeProject.customerName}" and job type "{activeProject.jobTypeName}".</p>}
            {activeAgg.ests.map(e => (
              <div key={e.id} style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                <strong>${e.total.toFixed(2)}</strong> · {e.rateType} · {e.status} · {new Date(e.createdAt).toLocaleDateString()}
              </div>
            ))}
          </div>

          {/* Change Orders Card */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0 }}>Change Orders ({activeAgg.cos.length})</h3>
              <button
                onClick={() => { setShowCoForm(!showCoForm); setShowInvForm(false) }}
                style={{ background: '#f97316', color: 'white', border: 'none', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                + Add
              </button>
            </div>

            {activeAgg.cos.length === 0 && !showCoForm && <p style={{ color: '#94a3b8', fontSize: '13px' }}>No change orders yet.</p>}

            {activeAgg.cos.map(co => {
              const coEmailKey = `co-${co.id}-email`
              const coSmsKey = `co-${co.id}-sms`
              const isEmailOpen = notifTarget?.type === 'co' && notifTarget.id === co.id && notifTarget.channel === 'email'
              const isSmsOpen = notifTarget?.type === 'co' && notifTarget.id === co.id && notifTarget.channel === 'sms'
              return (
                <div key={co.id} style={{ padding: '10px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '4px' }}>
                    <div>
                      <p style={{ fontWeight: 600, marginBottom: '2px' }}>{co.description}</p>
                      <p style={{ color: '#64748b' }}>+${co.additionalAmount.toFixed(2)} · New total: <strong>${co.newTotal.toFixed(2)}</strong></p>
                    </div>
                    <span style={statusBadgeStyle(co.status)}>{co.status}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                    {co.status === 'pending' && (
                      <>
                        <button onClick={() => updateCoStatus(co.id, 'approved')} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>
                        <button onClick={() => updateCoStatus(co.id, 'declined')} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Decline</button>
                      </>
                    )}
                    <button
                      onClick={() => isEmailOpen ? setNotifTarget(null) : openNotif('co', co.id, 'email')}
                      style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {notifSent.has(coEmailKey) ? '✓ Emailed' : 'Email'}
                    </button>
                    <button
                      onClick={() => isSmsOpen ? setNotifTarget(null) : openNotif('co', co.id, 'sms')}
                      style={{ background: '#16a34a', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {notifSent.has(coSmsKey) ? '✓ Texted' : 'Text'}
                    </button>
                  </div>
                  {(isEmailOpen || isSmsOpen) && (
                    <div style={{ marginTop: '8px', background: '#f8fafc', padding: '10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <label style={label}>{isEmailOpen ? 'Email address' : 'Phone number'}</label>
                      <input
                        value={notifAddress}
                        onChange={e => setNotifAddress(e.target.value)}
                        placeholder={isEmailOpen ? 'customer@example.com' : '+1 (555) 000-0000'}
                        style={{ ...input, marginBottom: '8px' }}
                      />
                      {notifError && <p style={{ color: '#dc2626', fontSize: '12px', marginBottom: '6px' }}>{notifError}</p>}
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => sendNotification('co', co)}
                          disabled={notifSending || !notifAddress}
                          style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                        >
                          {notifSending ? 'Sending...' : 'Send'}
                        </button>
                        <button onClick={() => { setNotifTarget(null); setNotifAddress('') }} style={{ background: '#f1f5f9', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {showCoForm && (
              <div style={{ marginTop: '12px', padding: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Description *</label>
                  <textarea value={coDescription} onChange={e => setCoDescription(e.target.value)} rows={2} placeholder="Describe the change..." style={{ ...input, fontFamily: 'inherit' }} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Additional Amount ($) *</label>
                  <input type="number" value={coAmount} onChange={e => setCoAmount(e.target.value)} placeholder="0.00" style={input} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Notes</label>
                  <textarea value={coNotes} onChange={e => setCoNotes(e.target.value)} rows={2} placeholder="Internal notes..." style={{ ...input, fontFamily: 'inherit' }} />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => saveChangeOrder(activeProject)} disabled={coLoading || !coDescription || !coAmount} style={{ background: '#f97316', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {coLoading ? 'Saving...' : 'Save Change Order'}
                  </button>
                  <button onClick={() => { setShowCoForm(false); setCoDescription(''); setCoAmount(''); setCoNotes('') }} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Invoices Card */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0 }}>🧾 Invoices ({activeAgg.invs.length})</h3>
              <button
                onClick={() => { setShowInvForm(!showInvForm); setShowCoForm(false) }}
                style={{ background: '#f97316', color: 'white', border: 'none', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                + Add
              </button>
            </div>

            {activeAgg.invs.length === 0 && !showInvForm && <p style={{ color: '#94a3b8', fontSize: '13px' }}>No invoices yet.</p>}

            {activeAgg.invs.map(inv => {
              const invEmailKey = `inv-${inv.id}-email`
              const invSmsKey = `inv-${inv.id}-sms`
              const isEmailOpen = notifTarget?.type === 'inv' && notifTarget.id === inv.id && notifTarget.channel === 'email'
              const isSmsOpen = notifTarget?.type === 'inv' && notifTarget.id === inv.id && notifTarget.channel === 'sms'
              return (
                <div key={inv.id} style={{ padding: '10px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '4px' }}>
                    <div>
                      <p style={{ fontWeight: 600, marginBottom: '2px' }}>
                        {inv.invoiceType.charAt(0).toUpperCase() + inv.invoiceType.slice(1)} · <strong>${inv.amount.toFixed(2)}</strong>
                      </p>
                      <p style={{ color: '#64748b', marginBottom: '2px' }}>{inv.description}</p>
                      {inv.dueDate && <p style={{ color: '#94a3b8', fontSize: '12px' }}>Due: {new Date(inv.dueDate).toLocaleDateString()}</p>}
                    </div>
                    <span style={statusBadgeStyle(inv.status)}>{inv.status}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                    {inv.status !== 'paid' && (
                      <button onClick={() => markInvoicePaid(inv.id)} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Mark Paid</button>
                    )}
                    <button
                      onClick={() => isEmailOpen ? setNotifTarget(null) : openNotif('inv', inv.id, 'email')}
                      style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {notifSent.has(invEmailKey) ? '✓ Emailed' : 'Email'}
                    </button>
                    <button
                      onClick={() => isSmsOpen ? setNotifTarget(null) : openNotif('inv', inv.id, 'sms')}
                      style={{ background: '#16a34a', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {notifSent.has(invSmsKey) ? '✓ Texted' : 'Text'}
                    </button>
                  </div>
                  {(isEmailOpen || isSmsOpen) && (
                    <div style={{ marginTop: '8px', background: '#f8fafc', padding: '10px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <label style={label}>{isEmailOpen ? 'Email address' : 'Phone number'}</label>
                      <input
                        value={notifAddress}
                        onChange={e => setNotifAddress(e.target.value)}
                        placeholder={isEmailOpen ? 'customer@example.com' : '+1 (555) 000-0000'}
                        style={{ ...input, marginBottom: '8px' }}
                      />
                      {notifError && <p style={{ color: '#dc2626', fontSize: '12px', marginBottom: '6px' }}>{notifError}</p>}
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => sendNotification('inv', inv)}
                          disabled={notifSending || !notifAddress}
                          style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                        >
                          {notifSending ? 'Sending...' : 'Send'}
                        </button>
                        <button onClick={() => { setNotifTarget(null); setNotifAddress('') }} style={{ background: '#f1f5f9', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {showInvForm && (
              <div style={{ marginTop: '12px', padding: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Invoice Type</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['deposit', 'milestone', 'final'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => setInvType(t)}
                        style={{
                          padding: '6px 12px', borderRadius: '6px', border: '2px solid', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
                          borderColor: invType === t ? '#f97316' : '#e2e8f0',
                          background: invType === t ? '#fff7ed' : 'white',
                          color: invType === t ? '#f97316' : '#64748b',
                        }}
                      >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Amount ($) *</label>
                  <input type="number" value={invAmount} onChange={e => setInvAmount(e.target.value)} placeholder="0.00" style={input} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Description *</label>
                  <textarea value={invDescription} onChange={e => setInvDescription(e.target.value)} rows={2} placeholder="Describe this invoice..." style={{ ...input, fontFamily: 'inherit' }} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Due Date (optional)</label>
                  <input type="date" value={invDueDate} onChange={e => setInvDueDate(e.target.value)} style={input} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={label}>Notes (optional)</label>
                  <textarea value={invNotes} onChange={e => setInvNotes(e.target.value)} rows={2} placeholder="Internal notes..." style={{ ...input, fontFamily: 'inherit' }} />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => saveInvoice(activeProject)} disabled={invLoading || !invAmount || !invDescription} style={{ background: '#f97316', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {invLoading ? 'Saving...' : 'Save Invoice'}
                  </button>
                  <button onClick={() => { setShowInvForm(false); setInvAmount(''); setInvDescription(''); setInvDueDate(''); setInvNotes('') }} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Before/After Photos ({activeAgg.photos.length})</h3>
            {activeAgg.photos.length === 0 && <p style={{ color: '#94a3b8', fontSize: '13px' }}>No photos.</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px' }}>
              {activeAgg.photos.map(p => (
                <img key={p.id} src={p.afterUrl || 'https://placehold.co/200x150/e2e8f0/64748b?text=Photo'} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: '4px' }} />
              ))}
            </div>
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>📁 Job Files <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>(coming soon)</span></h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Plans, supplier orders, permits, contracts, invoices — all in one place. Storage upload not wired yet.</p>
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>✍️ E-Signatures <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>(coming soon)</span></h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Customer signs contract + change orders digitally. Not wired yet.</p>
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>📞 Communications Log <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>(coming soon)</span></h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Log calls, texts, emails with this customer. Not wired yet.</p>
          </div>

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>🛡️ Warranty <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>(coming soon)</span></h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Generated at project closeout. Not wired yet.</p>
          </div>
        </div>

        {activeProject.notes && (
          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Notes</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{activeProject.notes}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700 }}>Projects</h2>
          <p style={{ color: '#64748b', marginTop: '4px' }}>Every job — from lead to closeout — in one view. The whole system per project.</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>+ New Project</button>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button onClick={() => setStatusFilter('all')} style={{ padding: '6px 14px', border: statusFilter === 'all' ? '2px solid #f97316' : '1px solid #e2e8f0', background: statusFilter === 'all' ? '#fff7ed' : 'white', borderRadius: '999px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
          All ({projects.length})
        </button>
        {PROJECT_STATUS_ORDER.map(s => {
          const count = projects.filter(p => p.status === s).length
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{ padding: '6px 14px', border: statusFilter === s ? '2px solid #f97316' : '1px solid #e2e8f0', background: statusFilter === s ? '#fff7ed' : 'white', borderRadius: '999px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
              {PROJECT_STATUS_LABEL[s]} ({count})
            </button>
          )
        })}
      </div>

      {showForm && (
        <div style={card}>
          <h3 style={{ marginBottom: '16px' }}>New Project</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '12px' }}>
            <div>
              <label style={label}>Customer *</label>
              {customers.length > 0 ? (
                <select value={customerName} onChange={e => setCustomerName(e.target.value)} style={input}>
                  <option value="">— Pick or type below —</option>
                  {customers.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              ) : (
                <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name" style={input} />
              )}
              {customers.length > 0 && <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="...or type new" style={{ ...input, marginTop: '6px' }} />}
            </div>
            <div>
              <label style={label}>Job Type *</label>
              <select value={jobTypeName} onChange={e => setJobTypeName(e.target.value)} style={input}>
                {JOB_CATALOG.map(j => <option key={j.id} value={j.name}>{j.name}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>Job ZIP</label>
              <input value={jobLocationZip} onChange={e => setJobLocationZip(e.target.value)} maxLength={5} placeholder="90210" style={input} />
            </div>
          </div>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="One-line description of the work..." style={{ ...input, fontFamily: 'inherit', marginBottom: '12px' }} />
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Notes (visible only to you)" style={{ ...input, fontFamily: 'inherit', marginBottom: '12px' }} />
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={save} disabled={loading || !customerName} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              {loading ? 'Creating...' : 'Create Project'}
            </button>
            <button onClick={() => setShowForm(false)} style={{ background: '#f1f5f9', border: 'none', padding: '10px 24px', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {filtered.length === 0 && !showForm && (
        <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: '48px' }}>
          {projects.length === 0 ? 'No projects yet. Create your first one above — it pulls together every other page.' : 'No projects with this status.'}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {filtered.map(p => {
          const agg = aggregateForProject(p)
          const sc = STATUS_COLOR[p.status]
          return (
            <div key={p.id} onClick={() => setActiveId(p.id)} style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer', borderLeft: `4px solid ${sc.text}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <h3 style={{ fontWeight: 700, fontSize: '16px' }}>{p.customerName}</h3>
                  <p style={{ color: '#64748b', fontSize: '13px', marginTop: '2px' }}>{p.jobTypeName}{p.jobLocationZip && ` · ${p.jobLocationZip}`}</p>
                  <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>
                    {agg.ests.length} estimate(s) · {agg.cos.length} change order(s) · {agg.invs.length} invoice(s) · {agg.photos.length} photos
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ background: sc.bg, color: sc.text, padding: '4px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' }}>{PROJECT_STATUS_LABEL[p.status]}</span>
                  {agg.contractTotal > 0 && (
                    <div style={{ marginTop: '6px', fontSize: '13px' }}>
                      <span style={{ color: '#f97316', fontWeight: 700 }}>${agg.contractTotal.toFixed(0)}</span> contract
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
