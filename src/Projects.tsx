import { useEffect, useMemo, useState } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, orderBy, updateDoc, doc, where } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'
import { JOB_CATALOG } from './data/jobCatalog'
import type { Estimate, Project, ProjectStatus } from './data/types'
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_ORDER } from './data/types'

interface Customer { id: string; name: string; phone: string; email: string; address: string }
interface PortfolioItem { id: string; title: string; afterUrl: string; createdAt: string }
interface ChangeOrder { id: string; estimateSnapshot: { customerName: string }; newTotal: number; createdAt: string }

const STATUS_COLOR: Record<ProjectStatus, { bg: string; text: string }> = {
  lead: { bg: '#f1f5f9', text: '#64748b' },
  estimated: { bg: '#fef3c7', text: '#d97706' },
  contracted: { bg: '#dbeafe', text: '#2563eb' },
  in_progress: { bg: '#fff7ed', text: '#ea580c' },
  completed: { bg: '#f0fdf4', text: '#16a34a' },
  closed: { bg: '#1a1f2e', text: '#cbd5e1' },
}

export default function Projects() {
  const { user } = useUser()
  const [projects, setProjects] = useState<Project[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([])
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

  const load = async () => {
    if (!user?.id) {
      setProjects([]); setCustomers([]); setEstimates([]); setChangeOrders([]); setPortfolio([])
      return
    }
    const own = (name: string) => query(
      collection(db, name),
      where('createdBy', '==', user.id),
      orderBy('createdAt', 'desc'),
    )
    try {
      const [pSnap, cSnap, eSnap, coSnap, poSnap] = await Promise.all([
        getDocs(own('projects')),
        getDocs(own('customers')),
        getDocs(own('estimates')),
        getDocs(own('changeOrders')),
        getDocs(own('portfolio')),
      ])
      setProjects(pSnap.docs.map(d => ({ id: d.id, ...d.data() } as Project)))
      setCustomers(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)))
      setEstimates(eSnap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate)))
      setChangeOrders(coSnap.docs.map(d => ({ id: d.id, ...d.data() } as ChangeOrder)))
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

  const aggregateForProject = (p: Project) => {
    const matchByName = (s: string) => s.toLowerCase() === p.customerName.toLowerCase()
    const ests = estimates.filter(e => matchByName(e.customerName) && e.jobTypeName === p.jobTypeName)
    const cos = changeOrders.filter(c => matchByName(c.estimateSnapshot.customerName))
    const photos = portfolio.filter(po => matchByName(po.title))
    const quoteTotal = ests.reduce((s, e) => s + e.total, 0)
    const coDelta = cos.reduce((s, c) => s + (c.newTotal - (ests[0]?.total ?? 0)), 0)
    const contractTotal = quoteTotal + (cos.length ? coDelta : 0)
    return { ests, cos, photos, quoteTotal, contractTotal }
  }

  const filtered = useMemo(() => statusFilter === 'all' ? projects : projects.filter(p => p.status === statusFilter), [projects, statusFilter])
  const activeProject = activeId ? projects.find(p => p.id === activeId) ?? null : null
  const activeAgg = activeProject ? aggregateForProject(activeProject) : null

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

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

          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Change Orders ({activeAgg.cos.length})</h3>
            {activeAgg.cos.length === 0 && <p style={{ color: '#94a3b8', fontSize: '13px' }}>None.</p>}
            {activeAgg.cos.map(c => (
              <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                New total: <strong>${c.newTotal.toFixed(2)}</strong> · {new Date(c.createdAt).toLocaleDateString()}
              </div>
            ))}
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
            <h3 style={{ marginBottom: '12px' }}>🧾 Invoices <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>(coming soon)</span></h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Generate milestone or final invoices. Not wired yet.</p>
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
                    {agg.ests.length} estimate(s) · {agg.cos.length} change order(s) · {agg.photos.length} photos
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
