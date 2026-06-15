import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from './firebase'
import { collection, addDoc, getDocs, query, updateDoc, deleteDoc, doc, where, onSnapshot } from 'firebase/firestore'
import { useUser } from '@clerk/clerk-react'
import { JOB_CATALOG } from './data/jobCatalog'
import type { Estimate, Project, ProjectStatus, ChangeOrder } from './data/types'
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_ORDER, CHANGE_ORDER_REASON_LABEL } from './data/types'
import ChangeOrderForm from './ChangeOrderForm'
import ShareChangeOrderModal from './ShareChangeOrderModal'
import ProjectPhotos, { fetchProjectPhotos } from './ProjectPhotos'
import { createThankYouPackage, regenerateThankYouLetter } from './lib/thankYouPackage'
import ShareThankYouModal from './ShareThankYouModal'
import ThankYouReviewModal from './ThankYouReviewModal'
import ShareInvoiceModal from './ShareInvoiceModal'
import { createInvoice, nextInvoiceNumber, regenerateInvoiceCopy } from './lib/createInvoice'
import InvoiceEditModal from './InvoiceEditModal'
import type { Invoice } from './data/types'
import EstimatePreview from './EstimatePreview'
import { openEstimatePrintWindow } from './lib/printEstimate'
import { PUBLIC_HOST } from './lib/config'
import { useTier } from './lib/useTier'
import { fetchBusinessProfile } from './Settings'
import type { BusinessProfile } from './Settings'
import type { ThankYouPackage } from './data/types'
import { useAuth } from '@clerk/clerk-react'
import { isPhone } from './lib/shareEstimate'

interface Customer { id: string; name: string; phone: string; email: string; address: string }

const STATUS_COLOR: Record<ProjectStatus, { bg: string; text: string }> = {
  lead: { bg: '#f1f5f9', text: '#64748b' },
  estimated: { bg: '#fef3c7', text: '#d97706' },
  contracted: { bg: '#dbeafe', text: '#2563eb' },
  in_progress: { bg: '#fff7ed', text: '#ea580c' },
  completed: { bg: '#f0fdf4', text: '#16a34a' },
  closed: { bg: '#1a1f2e', text: '#cbd5e1' },
}

export default function Projects({ initialStatusFilter }: { initialStatusFilter?: ProjectStatus | 'all' } = {}) {
  const { user } = useUser()
  const { getToken } = useAuth()
  const { tier } = useTier()  // 'pro' unlocks the thank-you letter feature
  const [projects, setProjects] = useState<Project[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([])
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [coFormOpen, setCoFormOpen] = useState(false)
  const [coEditing, setCoEditing] = useState<ChangeOrder | null>(null)
  const [coCopied, setCoCopied] = useState<string | null>(null)
  const [coShareOpen, setCoShareOpen] = useState<ChangeOrder | null>(null)
  const [thankYouLoading, setThankYouLoading] = useState(false)
  const [thankYouHighlights, setThankYouHighlights] = useState('')
  const [thankYouPanelOpen, setThankYouPanelOpen] = useState(false)
  const [thankYouShare, setThankYouShare] = useState<ThankYouPackage | null>(null)
  const [thankYouReview, setThankYouReview] = useState<ThankYouPackage | null>(null)
  const [thankYouAvailablePhotos, setThankYouAvailablePhotos] = useState<Array<{ id: string; photoUrl: string; caption: string; createdAt: string }>>([])
  const [thankYouSelectedIds, setThankYouSelectedIds] = useState<Set<string>>(new Set())
  const [estimatePreview, setEstimatePreview] = useState<Estimate | null>(null)
  const [profile, setProfile] = useState<BusinessProfile>({ businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '' })
  const [invoicePanelOpen, setInvoicePanelOpen] = useState(false)
  const [invoiceLoading, setInvoiceLoading] = useState(false)
  const [invoiceAmountPaid, setInvoiceAmountPaid] = useState('')
  const [invoiceDueDays, setInvoiceDueDays] = useState('14')
  const [invoiceShare, setInvoiceShare] = useState<Invoice | null>(null)
  const [invoiceEdit, setInvoiceEdit] = useState<Invoice | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>(initialStatusFilter ?? 'all')
  const [viewMode, setViewMode] = useState<'active' | 'completed' | 'declined'>('active')
  const [searchQuery, setSearchQuery] = useState('')

  const [customerName, setCustomerName] = useState('')
  const [jobTypeName, setJobTypeName] = useState(JOB_CATALOG[0].name)
  const [jobLocationZip, setJobLocationZip] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')

  const load = async () => {
    if (!user?.id) {
      setProjects([]); setCustomers([]); setEstimates([]); setChangeOrders([])
      return
    }
    const own = (name: string) => query(collection(db, name), where('createdBy', '==', user.id))
    const sortDesc = <T extends { createdAt?: string }>(arr: T[]) =>
      arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    try {
      const [pSnap, cSnap, eSnap, coSnap] = await Promise.all([
        getDocs(own('projects')),
        getDocs(own('customers')),
        getDocs(own('estimates')),
        getDocs(own('changeOrders')),
      ])
      setProjects(sortDesc(pSnap.docs.map(d => ({ id: d.id, ...d.data() } as Project))))
      setCustomers(sortDesc(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Customer & { createdAt?: string }))))
      setEstimates(sortDesc(eSnap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate))))
      setChangeOrders(sortDesc(coSnap.docs.map(d => ({ id: d.id, ...d.data() } as ChangeOrder))))
    } catch (err) {
      console.error('Projects load failed:', err)
    }
  }
  useEffect(() => { load() }, [user?.id])

  // Live subscription on projects so status changes (e.g. a customer approving
  // an estimate auto-moves the project to In Progress) appear without a manual
  // refresh, even while the contractor is sitting on this page.
  useEffect(() => {
    if (!user?.id) return
    const sortDesc = <T extends { createdAt?: string }>(arr: T[]) =>
      arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    const unsub = onSnapshot(
      query(collection(db, 'projects'), where('createdBy', '==', user.id)),
      snap => setProjects(sortDesc(snap.docs.map(d => ({ id: d.id, ...d.data() } as Project)))),
      err => console.error('Projects listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  // Live subscription on invoices so already-created invoices can be re-opened,
  // edited, and re-sent — and so a customer's payment (status → paid via the
  // Stripe webhook) reflects here in real time.
  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(
      query(collection(db, 'invoices'), where('createdBy', '==', user.id)),
      snap => setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() } as Invoice))),
      err => console.error('Invoices listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  // Live subscription on changeOrders so when a customer approves/declines one
  // from the public share link, the project view reflects it immediately:
  // status badge flips, and the Contract Total recalculates with the new
  // approved delta folded in. No refresh needed.
  useEffect(() => {
    if (!user?.id) return
    const sortDesc = <T extends { createdAt?: string }>(arr: T[]) =>
      arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    const unsub = onSnapshot(
      query(collection(db, 'changeOrders'), where('createdBy', '==', user.id)),
      snap => setChangeOrders(sortDesc(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChangeOrder)))),
      err => console.error('Change orders listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  // After a customer pays (card or cash-choice), the dashboard listener stashes
  // the related projectId in sessionStorage. When this page mounts and projects
  // are loaded, auto-open that project and its thank-you panel so the user
  // lands ready to send the thank-you letter — no extra clicks. Runs once
  // per mount when projects first arrive.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (projects.length === 0 || !user?.id) return
    // Key is user-scoped (set in App.tsx with the same user.id) so a different
    // contractor on the same browser doesn't inherit a stale signal.
    const sessionKey = `bp_open_thanks_for_project_${user.id}`
    let projectId: string | null = null
    try { projectId = window.sessionStorage?.getItem(sessionKey) || null } catch { /* noop */ }
    if (!projectId) return
    const target = projects.find(p => p.id === projectId)
    if (!target) return
    autoOpenedRef.current = true
    try { window.sessionStorage?.removeItem(sessionKey) } catch { /* noop */ }
    setActiveId(target.id)
    openThankYouPanel(target).catch(err => console.error('Auto-open thank-you failed:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, user?.id])

  // Load the contractor's full business profile so print/PDF letterhead
  // and thank-you letter can use logo + contact info + license number.
  useEffect(() => {
    if (!user?.id) return
    fetchBusinessProfile(user.id).then(setProfile).catch(() => { /* ignore */ })
  }, [user?.id])

  const save = async () => {
    if (!customerName) { alert('Please enter a customer name.'); return }
    if (!user?.id) { alert('Not signed in.'); return }
    setLoading(true)
    const matchedCustomerId = customers.find(c => c.name === customerName)?.id
    const payload: Record<string, unknown> = {
      customerName,
      jobTypeName,
      jobLocationZip: jobLocationZip || '',
      description: description || '',
      status: 'lead',
      notes: notes || '',
      createdAt: new Date().toISOString(),
      createdBy: user.id,
    }
    if (matchedCustomerId) payload.customerId = matchedCustomerId
    try {
      await addDoc(collection(db, 'projects'), payload)
      setCustomerName(''); setJobLocationZip(''); setDescription(''); setNotes('')
      setShowForm(false)
      await load()
    } catch (err) {
      console.error('Project save failed:', err)
      alert('Could not save the project: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  const advance = async (p: Project, status: ProjectStatus) => {
    try {
      const extra = status === 'closed' ? { closedAt: new Date().toISOString() } : {}
      await updateDoc(doc(db, 'projects', p.id), { status, ...extra })
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status, ...extra } : x))
    } catch (err) {
      console.error('Status update failed:', err)
      alert('Could not update status: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // The one manual milestone: In Progress → Completed. The app can't detect
  // when physical work is done, so this button is the contractor's signal.
  const markComplete = async (p: Project) => {
    if (!confirm(`Mark the ${p.jobTypeName} job for "${p.customerName}" as complete? This moves it to Completed and lets you send the thank-you letter and final invoice.`)) return
    try {
      const completedAt = new Date().toISOString()
      await updateDoc(doc(db, 'projects', p.id), { status: 'completed', completedAt })
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status: 'completed', completedAt } : x))
    } catch (err) {
      alert('Could not mark complete: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const setProjectStartDate = async (p: Project, dateStr: string) => {
    try {
      const startDate = dateStr || ''
      await updateDoc(doc(db, 'projects', p.id), { startDate })
      // Local update for instant feedback (listener will reconcile too).
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, startDate } : x))
    } catch (err) {
      alert('Could not set start date: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const deleteProject = async (p: Project) => {
    if (!confirm(`Delete the project for "${p.customerName}" (${p.jobTypeName})? This cannot be undone. Linked estimates and change orders stay.`)) return
    try {
      await deleteDoc(doc(db, 'projects', p.id))
      setProjects(prev => prev.filter(x => x.id !== p.id))
      setActiveId(null)
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // Archive a completed project into the Completed Jobs folder. The project
  // stays in Firestore — just gets the `archived` flag — so the user can
  // restore or permanently delete it later.
  const archiveProject = async (p: Project) => {
    if (!confirm(`Move "${p.customerName} — ${p.jobTypeName}" to the Completed Jobs folder?`)) return
    try {
      const archivedAt = new Date().toISOString()
      await updateDoc(doc(db, 'projects', p.id), { archived: true, archivedAt })
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, archived: true, archivedAt } : x))
      setActiveId(null)
    } catch (err) {
      alert('Archive failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const restoreProject = async (p: Project) => {
    try {
      await updateDoc(doc(db, 'projects', p.id), { archived: false })
      setProjects(prev => prev.map(x => x.id === p.id ? { ...x, archived: false } : x))
    } catch (err) {
      alert('Restore failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const openThankYouPanel = async (project: Project) => {
    if (!user?.id) return
    setThankYouPanelOpen(true)
    try {
      const photos = await fetchProjectPhotos(project.id, user.id)
      const list = photos.map(p => ({ id: p.id, photoUrl: p.photoUrl, caption: p.caption, createdAt: p.createdAt }))
      setThankYouAvailablePhotos(list)
      setThankYouSelectedIds(new Set(list.map(p => p.id)))  // default = all selected
    } catch (err) {
      console.error('Photo fetch for thank-you failed:', err)
    }
  }

  const generateThankYouPackage = async (project: Project) => {
    if (!user?.id) { alert('Not signed in.'); return }
    setThankYouLoading(true)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const allPhotos = await fetchProjectPhotos(project.id, user.id)
      // Filter down to only the photos the user selected (or all if they
      // never opened the picker).
      const selectedSet = thankYouSelectedIds.size > 0 || thankYouAvailablePhotos.length > 0
        ? thankYouSelectedIds
        : new Set(allPhotos.map(p => p.id))
      const photos = allPhotos.filter(p => selectedSet.has(p.id))
      const pkg = await createThankYouPackage({
        clerkToken,
        userId: user.id,
        project,
        photos,
        contractorName: user.fullName || user.firstName || undefined,
        contractorBusiness: profile.businessName || undefined,
        highlights: thankYouHighlights.trim() || undefined,
      })
      // Open the review/edit/regenerate modal — user reviews, tweaks, then sends.
      setThankYouReview(pkg)
      setThankYouPanelOpen(false)
      setThankYouHighlights('')
      setThankYouAvailablePhotos([])
      setThankYouSelectedIds(new Set())
    } catch (err) {
      alert('Could not generate thank-you package: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setThankYouLoading(false)
    }
  }

  // Build & save an invoice for the given project, then pop the share modal.
  // Pulls in the project's estimates + approved change orders to roll up
  // line items, asks Claude for cover copy, persists to invoices/{id}.
  const generateInvoiceForProject = async (project: Project, agg: { ests: Estimate[]; cos: ChangeOrder[] }) => {
    if (!user?.id) { alert('Not signed in.'); return }
    if (agg.ests.length === 0) {
      alert('No estimates linked to this project. Create an estimate first via Quick Quote, then come back here to invoice it.')
      return
    }
    setInvoiceLoading(true)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')

      // Pull customer contact info if available.
      const customer = customers.find(c => c.name.toLowerCase() === project.customerName.toLowerCase())

      // Generate an invoice number — count existing invoices for this user this year.
      const existingThisYear = await getDocs(query(
        collection(db, 'invoices'),
        where('createdBy', '==', user.id),
      ))
      const thisYear = new Date().getFullYear()
      const sameYearCount = existingThisYear.docs.filter(d => {
        const c = d.data().createdAt as string
        return c && new Date(c).getFullYear() === thisYear
      }).length

      const invoice = await createInvoice({
        clerkToken,
        userId: user.id,
        project: {
          id: project.id,
          customerName: project.customerName,
          customerId: project.customerId,
          jobTypeName: project.jobTypeName,
          jobLocationZip: project.jobLocationZip,
        },
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
        customerAddress: customer?.address,
        estimates: agg.ests,
        changeOrders: agg.cos,
        profile,
        contractorName: user.fullName || user.firstName || undefined,
        // Auto-credit any PAID deposit for this project, plus anything the
        // contractor manually enters — so the final invoice shows the correct
        // remaining balance.
        amountPaid: paidDepositForProject(project.id) + (Number(invoiceAmountPaid) || 0),
        dueInDays: Number(invoiceDueDays) || 14,
        invoiceNumber: nextInvoiceNumber(sameYearCount),
      })
      setInvoiceEdit(invoice)
      setInvoicePanelOpen(false)
      setInvoiceAmountPaid('')
      setInvoiceDueDays('14')
    } catch (err) {
      alert('Could not generate invoice: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setInvoiceLoading(false)
    }
  }

  const onChangeOrderSaved = (co: ChangeOrder) => {
    const wasEdit = changeOrders.some(x => x.id === co.id)
    setChangeOrders(prev => {
      const existing = prev.findIndex(x => x.id === co.id)
      if (existing >= 0) return prev.map((x, i) => i === existing ? co : x)
      return [co, ...prev]
    })
    setCoFormOpen(false)
    setCoEditing(null)
    // Auto-pop the share modal for NEW change orders so the contractor
    // sends it to the customer right away. Skip on edits.
    if (!wasEdit) {
      setCoShareOpen(co)
    }
  }

  const deleteChangeOrder = async (co: ChangeOrder) => {
    // 2-YEAR LEGAL RETENTION: a signed change order is locked as proof.
    if (co.signedAtMs) {
      const until = new Date(co.signedAtMs + 63072000000)
      if (Date.now() < until.getTime()) {
        alert(`🔒 This change order is signed by ${co.customerResponse?.signedName || co.customerName} and is protected as a legal record. It can't be deleted until ${until.toLocaleDateString()} (2 years after signing).`)
        return
      }
    }
    if (!confirm(`Delete this change order? This cannot be undone.`)) return
    try {
      await deleteDoc(doc(db, 'changeOrders', co.id))
      setChangeOrders(prev => prev.filter(x => x.id !== co.id))
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const copyChangeOrderLink = async (coId: string) => {
    const link = `${PUBLIC_HOST}/co/${coId}`
    try {
      await navigator.clipboard.writeText(link)
      setCoCopied(coId)
      setTimeout(() => setCoCopied(null), 2500)
    } catch {
      alert(`Copy failed. Manual link: ${link}`)
    }
  }

  const smsCoHref = (co: ChangeOrder, fromName?: string) => {
    const link = `${PUBLIC_HOST}/co/${co.id}`
    // Link-first, short body — survives iPhone→Android SMS truncation.
    const body = `${link}\n\nChange order from ${fromName || 'your contractor'} for ${co.customerName}.`
    const enc = encodeURIComponent(body)
    if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return `sms:&body=${enc}`
    return `sms:?body=${enc}`
  }

  const mailtoCoHref = (co: ChangeOrder, fromName?: string) => {
    const link = `${PUBLIC_HOST}/co/${co.id}`
    const subject = `Change order for your project`
    const body = `Hi ${co.customerName},

There's a change order on your project for review and approval:

${link}

— ${fromName || 'Your contractor'}`
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  // Sum of PAID deposit invoices for a project — credited against the final
  // invoice so the customer only owes the remaining balance.
  const paidDepositForProject = (projectId: string) =>
    +invoices
      .filter(inv => inv.projectId === projectId && inv.isDeposit && inv.status === 'paid')
      .reduce((s, inv) => s + (inv.subtotal || 0), 0)
      .toFixed(2)

  const aggregateForProject = (p: Project) => {
    // Prefer the explicit projectId link when present (new shape). Fall back
    // to customer-name + job-type matching ONLY for legacy estimates that
    // were created before the link existed. This prevents double-counting
    // when one customer has two same-type projects (e.g. two bathrooms).
    const matchByName = (s: string) => s.toLowerCase() === p.customerName.toLowerCase()
    const ests = estimates.filter(e => e.projectId
      ? e.projectId === p.id
      : (matchByName(e.customerName) && e.jobTypeName === p.jobTypeName))
    // Filter change orders by projectId (new shape).
    const cos = changeOrders.filter(c => c.projectId === p.id)
    const quoteTotal = ests.reduce((s, e) => s + e.total, 0)
    // Only APPROVED change orders change the contract total. Pending/declined
    // ones are shown in the list but must not inflate what the customer owes.
    const coDelta = cos.reduce((s, c) => s + (c.status === 'approved' ? (c.delta || 0) : 0), 0)
    const contractTotal = quoteTotal + coDelta
    return { ests, cos, quoteTotal, contractTotal }
  }

  const archivedCount = useMemo(() => projects.filter(p => p.archived && !p.declined).length, [projects])
  const declinedCount = useMemo(() => projects.filter(p => p.declined).length, [projects])
  const filtered = useMemo(() => {
    // Three buckets: active (default), completed (archived), declined.
    let pool: Project[]
    if (viewMode === 'declined') pool = projects.filter(p => p.declined)
    else if (viewMode === 'completed') pool = projects.filter(p => p.archived && !p.declined)
    else pool = projects.filter(p => !p.archived && !p.declined)
    if (statusFilter !== 'all') pool = pool.filter(p => p.status === statusFilter)
    // Free-text search across customer name, job type, ZIP, and notes.
    const q = searchQuery.trim().toLowerCase()
    if (q) pool = pool.filter(p =>
      (p.customerName || '').toLowerCase().includes(q)
      || (p.jobTypeName || '').toLowerCase().includes(q)
      || (p.jobLocationZip || '').toLowerCase().includes(q)
      || (p.description || '').toLowerCase().includes(q),
    )
    return pool
  }, [projects, statusFilter, viewMode, searchQuery])
  const activeProject = activeId ? projects.find(p => p.id === activeId) ?? null : null
  const activeAgg = activeProject ? aggregateForProject(activeProject) : null

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', marginBottom: '16px' }

  if (activeProject && activeAgg) {
    const sc = STATUS_COLOR[activeProject.status]
    const customer = customers.find(c => c.name === activeProject.customerName)
    const idx = PROJECT_STATUS_ORDER.indexOf(activeProject.status)
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => setActiveId(null)} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer' }}>← Back to {viewMode === 'completed' ? 'Completed Jobs' : viewMode === 'declined' ? 'Declined' : 'Projects'}</button>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/* Restore button — only when viewing an already-archived project */}
            {activeProject.archived && (
              <button onClick={async () => { await restoreProject(activeProject); setActiveId(null) }} style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #16a34a', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                ↩️ Restore to Active
              </button>
            )}
            {/* Archive button — only when project is finished and not already archived */}
            {!activeProject.archived && (activeProject.status === 'completed' || activeProject.status === 'closed') && (
              <button onClick={() => archiveProject(activeProject)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                📦 Move to Completed Jobs
              </button>
            )}
            <button onClick={() => deleteProject(activeProject)} style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #dc2626', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              🗑️ Delete{activeProject.archived ? ' Permanently' : ' Project'}
            </button>
          </div>
        </div>

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
              {/* Status now advances automatically:
                  lead → in_progress  on customer approval (no button)
                  in_progress → completed  via the prominent banner below the header
                  completed → closed  automatically when the invoice is paid */}
              {(activeProject.status === 'lead' || activeProject.status === 'estimated' || activeProject.status === 'contracted') && (
                <p style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8', maxWidth: '180px' }}>
                  ⏳ Auto-advances to <strong>In Progress</strong> when the customer approves the estimate.
                </p>
              )}
              {activeProject.status === 'completed' && (
                <>
                  <p style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8', maxWidth: '190px' }}>
                    💳 Auto-closes when the invoice is paid in full.
                  </p>
                  <button onClick={() => advance(activeProject, 'closed')} style={{ display: 'block', marginTop: '8px', background: 'transparent', color: '#cbd5e1', border: '1px solid #475569', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '11px' }}>
                    Close manually
                  </button>
                </>
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

        {/* PROMINENT completion call-to-action — the one manual milestone. Shown
            big and full-width so contractors don't miss that they must mark the
            job complete to unlock the final stages (thank-you + final invoice). */}
        {activeProject.status === 'in_progress' && (
          <div style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)', color: 'white', borderRadius: '12px', padding: 'clamp(16px, 4vw, 22px)', marginBottom: '16px', boxShadow: '0 8px 24px rgba(22,163,74,0.28)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <div style={{ flex: '1 1 280px' }}>
                <p style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>🏗️ Job In Progress</p>
                <p style={{ margin: '6px 0 0', fontSize: '14px', lineHeight: 1.5, color: '#dcfce7' }}>
                  Work finished? <strong>Mark it complete</strong> to unlock the customer <strong>Thank-You letter</strong> and the <strong>Final Invoice</strong> — the last steps of the job.
                </p>
              </div>
              <button onClick={() => markComplete(activeProject)} style={{ flex: '0 0 auto', background: 'white', color: '#15803d', border: 'none', padding: '16px 28px', borderRadius: '10px', cursor: 'pointer', fontWeight: 800, fontSize: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.18)', whiteSpace: 'nowrap' }}>
                ✓ Mark Job Complete
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Contract Total</p><p style={{ fontSize: '22px', fontWeight: 700, color: '#f97316' }}>${activeAgg.contractTotal.toFixed(2)}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Estimates</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{activeAgg.ests.length}</p></div>
          <div style={card}><p style={{ color: '#64748b', fontSize: '12px' }}>Change Orders</p><p style={{ fontSize: '22px', fontWeight: 700 }}>{activeAgg.cos.length}</p></div>
        </div>

        {/* Schedule — set the job's start date. Shows on the Schedule view. */}
        <div style={{ ...card, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '160px' }}>
            <p style={{ margin: 0, fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>📅 Scheduled Start</p>
            <p style={{ margin: '2px 0 0', fontSize: '14px', color: activeProject.startDate ? '#1a1f2e' : '#94a3b8' }}>
              {activeProject.startDate ? new Date(activeProject.startDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'No start date set'}
            </p>
          </div>
          <input
            type="date"
            value={activeProject.startDate ? activeProject.startDate.slice(0, 10) : ''}
            onChange={e => setProjectStartDate(activeProject, e.target.value)}
            style={{ padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '14px' }}
          />
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
              <h3 style={{ margin: 0 }}>📝 Estimates ({activeAgg.ests.length})</h3>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Need another? Use ⚡ Quick Quote in the sidebar.</span>
            </div>
            {activeAgg.ests.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: '13px' }}>
                No estimates yet for this project. Tap <strong>⚡ Quick Quote</strong> in the sidebar to make one for <strong>{activeProject.customerName}</strong>.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {activeAgg.ests.map(e => {
                  const statusColor = e.status === 'approved' ? { bg: '#f0fdf4', text: '#16a34a' } : e.status === 'declined' ? { bg: '#fef2f2', text: '#dc2626' } : { bg: '#fff7ed', text: '#ea580c' }
                  return (
                    <div
                      key={e.id}
                      onClick={() => setEstimatePreview(e)}
                      style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', background: '#fafafa', cursor: 'pointer', transition: 'border-color 0.1s' }}
                      onMouseOver={ev => (ev.currentTarget.style.borderColor = '#f97316')}
                      onMouseOut={ev => (ev.currentTarget.style.borderColor = '#e2e8f0')}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px', flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontWeight: 700, fontSize: '15px', color: '#f97316' }}>${e.total.toFixed(2)}</p>
                          <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#64748b' }}>
                            {e.rateType === 'flat' ? 'Flat rate' : `${e.estimatedHours}h × $${e.hourlyRate}/hr`} · {new Date(e.createdAt).toLocaleDateString()}
                          </p>
                          {e.customerResponse && (
                            <p style={{ margin: '4px 0 0', fontSize: '11px', color: e.customerResponse.action === 'approved' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                              {e.customerResponse.action === 'approved' ? '✓' : '✕'} {e.customerResponse.signedName} · {new Date(e.customerResponse.respondedAt).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <span style={{ background: statusColor.bg, color: statusColor.text, padding: '3px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'capitalize' }}>{e.status}</span>
                      </div>
                      <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#94a3b8' }}>👁️ Tap to preview, edit & send →</p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
              <h3 style={{ margin: 0 }}>🔄 Change Orders ({activeAgg.cos.length})</h3>
              <button
                onClick={() => { setCoEditing(null); setCoFormOpen(true) }}
                style={{ background: '#f97316', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}
              >
                + New Change Order
              </button>
            </div>
            {activeAgg.cos.length === 0 && <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>None yet. Click + New Change Order to add one.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {activeAgg.cos.map(c => {
                const statusColor = c.status === 'approved' ? { bg: '#f0fdf4', text: '#16a34a' } : c.status === 'declined' ? { bg: '#fef2f2', text: '#dc2626' } : { bg: '#fff7ed', text: '#ea580c' }
                return (
                  <div key={c.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', background: '#fafafa' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{c.description}</p>
                        <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#64748b' }}>
                          {CHANGE_ORDER_REASON_LABEL[c.reason]} · {new Date(c.createdAt).toLocaleDateString()} · {c.lineItems.length} line item{c.lineItems.length === 1 ? '' : 's'}
                        </p>
                      </div>
                      <span style={{ background: statusColor.bg, color: statusColor.text, padding: '4px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'capitalize' }}>{c.status}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #e2e8f0', marginTop: '6px' }}>
                      <span style={{ fontSize: '13px', color: '#64748b' }}>
                        {c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(2)} → <strong style={{ color: '#f97316' }}>${c.newTotal.toFixed(2)}</strong>
                      </span>
                    </div>
                    {c.customerResponse && (
                      <p style={{ margin: '4px 0 0', fontSize: '12px', color: c.customerResponse.action === 'approved' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                        {c.customerResponse.action === 'approved' ? '✓' : '✕'} {c.customerResponse.signedName} · {new Date(c.customerResponse.respondedAt).toLocaleDateString()}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
                      <button onClick={() => { setCoEditing(c); setCoFormOpen(true) }} style={{ background: 'white', border: '1px solid #cbd5e1', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>✏️ Edit</button>
                      {isPhone() && (
                        <a href={smsCoHref(c, user?.fullName || user?.firstName || undefined)} style={{ background: 'white', border: '1px solid #cbd5e1', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>💬 Text</a>
                      )}
                      <a href={mailtoCoHref(c, user?.fullName || user?.firstName || undefined)} style={{ background: 'white', border: '1px solid #cbd5e1', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>✉️ Email</a>
                      <button onClick={() => copyChangeOrderLink(c.id)} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 700 }}>
                        {coCopied === c.id ? '✓ Copied' : '🔗 Copy link'}
                      </button>
                      <button onClick={() => deleteChangeOrder(c)} style={{ background: 'transparent', color: '#dc2626', border: '1px solid #fecaca', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>🗑️</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div style={card}>
            <ProjectPhotos project={activeProject} />
          </div>

          {/* Thank-You Package — shown when project is Completed or Closed */}
          {(activeProject.status === 'completed' || activeProject.status === 'closed') && (
            <div style={{ ...card, border: '2px solid #f97316', background: '#fff7ed' }}>
              {invoices.some(inv => inv.projectId === activeProject.id && inv.status === 'paid') && (
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px', fontSize: '13px', color: '#16a34a', fontWeight: 600 }}>
                  💳 Invoice paid — now's the perfect time to send {activeProject.customerName.split(' ')[0]} a thank-you with photos from the job.
                </div>
              )}
              <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>🎁 Customer Thank-You Package <span style={{ fontSize: '11px', fontWeight: 800, color: '#7c3aed', background: '#f3e8ff', padding: '2px 8px', borderRadius: '999px', verticalAlign: 'middle' }}>PRO</span></h3>
              <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#64748b' }}>
                A warm, professionally written thank-you letter (with photos you choose from the whole job) — shareable via SMS, email, or a copy link. Customer can save it as a PDF.
              </p>

              {tier !== 'pro' ? (
                // Pro-locked: the thank-you letter is a paid perk. Show an
                // upgrade prompt instead of the build button for free users.
                <div style={{ background: 'white', border: '1px solid #e9d5ff', borderRadius: '8px', padding: '14px' }}>
                  <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#1a1f2e' }}>
                    ✨ Sending a personalized thank-you with job photos is a <strong>BuildPro+ Pro</strong> feature — a memorable touch that wins repeat business and referrals.
                  </p>
                  <button
                    onClick={() => document.dispatchEvent(new CustomEvent('bp-go-settings'))}
                    style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(124,58,237,0.25)' }}
                  >
                    ⚡ Upgrade to Pro to unlock
                  </button>
                </div>
              ) : !thankYouPanelOpen ? (
                <button
                  onClick={() => openThankYouPanel(activeProject)}
                  style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}
                >
                  🎁 Build Thank-You Package
                </button>
              ) : (
                <>
                  {/* Photo picker */}
                  <div style={{ background: 'white', border: '1px solid #fed7aa', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#1a1f2e', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Pick photos for the slideshow ({thankYouSelectedIds.size} / {thankYouAvailablePhotos.length})
                      </span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => setThankYouSelectedIds(new Set(thankYouAvailablePhotos.map(p => p.id)))} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>
                          Select all
                        </button>
                        <button onClick={() => setThankYouSelectedIds(new Set())} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>
                          Clear all
                        </button>
                      </div>
                    </div>
                    {thankYouAvailablePhotos.length === 0 ? (
                      <p style={{ color: '#94a3b8', fontSize: '13px', margin: '8px 0', textAlign: 'center' }}>
                        No photos in this project album yet. The letter will still generate — just without a slideshow.
                      </p>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px' }}>
                        {thankYouAvailablePhotos.map(p => {
                          const selected = thankYouSelectedIds.has(p.id)
                          return (
                            <div
                              key={p.id}
                              onClick={() => {
                                const next = new Set(thankYouSelectedIds)
                                if (selected) next.delete(p.id); else next.add(p.id)
                                setThankYouSelectedIds(next)
                              }}
                              style={{
                                position: 'relative',
                                border: selected ? '3px solid #16a34a' : '3px solid transparent',
                                borderRadius: '8px',
                                overflow: 'hidden',
                                cursor: 'pointer',
                                opacity: selected ? 1 : 0.5,
                                transition: 'all 0.15s',
                              }}
                            >
                              <img src={p.photoUrl} alt="" style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                              <div style={{
                                position: 'absolute', top: '4px', right: '4px',
                                width: '22px', height: '22px',
                                borderRadius: '50%',
                                background: selected ? '#16a34a' : 'rgba(255,255,255,0.9)',
                                color: selected ? 'white' : '#64748b',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '13px', fontWeight: 700, boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                              }}>
                                {selected ? '✓' : '+'}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Notes for AI */}
                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                      Notes to include (optional)
                    </label>
                    <textarea
                      value={thankYouHighlights}
                      onChange={e => setThankYouHighlights(e.target.value)}
                      rows={3}
                      placeholder="Anything you want mentioned? E.g. 'Customer was extremely patient with the rain delays.'"
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => generateThankYouPackage(activeProject)}
                      disabled={thankYouLoading}
                      style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: thankYouLoading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}
                    >
                      {thankYouLoading ? '✨ Generating…' : `✨ Generate (${thankYouSelectedIds.size} photo${thankYouSelectedIds.size === 1 ? '' : 's'})`}
                    </button>
                    <button onClick={() => { setThankYouPanelOpen(false); setThankYouHighlights(''); setThankYouAvailablePhotos([]); setThankYouSelectedIds(new Set()) }} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Final Invoice — shown only once the job is marked Complete (or
              closed). A job in progress isn't invoiced yet. */}
          {(activeProject.status === 'completed' || activeProject.status === 'closed') && (
            <div style={{ ...card, border: '2px solid #16a34a', background: '#f0fdf4' }}>
              <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>🧾 Final Invoice</h3>
              <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#64748b' }}>
                Generate a professional invoice rolling up the estimate ({activeAgg.ests.length}) and approved change orders ({activeAgg.cos.filter(c => c.status === 'approved').length}). Includes a written cover note + payment terms. Customer gets a share link they can pay against.
              </p>

              {/* Existing invoices for this project — click to edit or resend. */}
              {invoices.filter(inv => inv.projectId === activeProject.id).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                  {invoices.filter(inv => inv.projectId === activeProject.id)
                    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                    .map(inv => {
                      const paid = inv.status === 'paid'
                      return (
                        <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', background: 'white', border: '1px solid #86efac', borderRadius: '8px', padding: '10px 12px', flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0 }}>
                            <span style={{ fontWeight: 700, fontSize: '14px' }}>{inv.invoiceNumber}</span>
                            <span style={{ marginLeft: '8px', fontSize: '13px', color: '#64748b' }}>
                              {paid ? `Paid $${(inv.subtotal || 0).toFixed(2)}` : `$${(inv.amountDue || 0).toFixed(2)} due`}
                            </span>
                            <span style={{ marginLeft: '8px', background: paid ? '#f0fdf4' : '#fff7ed', color: paid ? '#16a34a' : '#ea580c', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' }}>{inv.status}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {!paid && <button onClick={() => setInvoiceEdit(inv)} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>✏️ Edit</button>}
                            <button onClick={() => setInvoiceShare(inv)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>📤 Send</button>
                          </div>
                        </div>
                      )
                    })}
                </div>
              )}

              {!invoicePanelOpen ? (
                <button
                  onClick={() => setInvoicePanelOpen(true)}
                  style={{ background: '#16a34a', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(22,163,74,0.25)' }}
                >
                  🧾 Build Invoice
                </button>
              ) : (
                <>
                  <div style={{ background: 'white', border: '1px solid #86efac', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                          Deposit already paid ($)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={invoiceAmountPaid}
                          onChange={e => setInvoiceAmountPaid(e.target.value)}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
                          Due in (days)
                        </label>
                        <input
                          type="number"
                          value={invoiceDueDays}
                          onChange={e => setInvoiceDueDays(e.target.value)}
                          placeholder="14"
                          style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                        />
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => generateInvoiceForProject(activeProject, activeAgg)}
                      disabled={invoiceLoading}
                      style={{ background: '#16a34a', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: invoiceLoading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(22,163,74,0.25)' }}
                    >
                      {invoiceLoading ? '✨ Building invoice…' : '✨ Generate Invoice'}
                    </button>
                    <button
                      onClick={() => { setInvoicePanelOpen(false); setInvoiceAmountPaid(''); setInvoiceDueDays('14') }}
                      style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {activeProject.notes && (
          <div style={card}>
            <h3 style={{ marginBottom: '12px' }}>Notes</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{activeProject.notes}</p>
          </div>
        )}

        {coFormOpen && (
          <ChangeOrderForm
            projectId={activeProject.id}
            customerName={activeProject.customerName}
            jobTypeName={activeProject.jobTypeName}
            jobLocationZip={activeProject.jobLocationZip}
            originalTotal={activeAgg.quoteTotal}
            existing={coEditing}
            onClose={() => { setCoFormOpen(false); setCoEditing(null) }}
            onSaved={onChangeOrderSaved}
          />
        )}

        {coShareOpen && (
          <ShareChangeOrderModal
            changeOrder={coShareOpen}
            fromName={user?.fullName || user?.firstName || undefined}
            onClose={() => setCoShareOpen(null)}
          />
        )}

        {thankYouShare && (
          <ShareThankYouModal
            pkg={thankYouShare}
            fromName={user?.fullName || user?.firstName || undefined}
            onClose={() => setThankYouShare(null)}
          />
        )}

        {thankYouReview && (
          <ThankYouReviewModal
            pkg={thankYouReview}
            fromName={user?.fullName || user?.firstName || undefined}
            onClose={() => setThankYouReview(null)}
            onRegenerate={async (highlights) => {
              const clerkToken = await getToken()
              if (!clerkToken) throw new Error('Not signed in')
              return regenerateThankYouLetter({
                clerkToken,
                customerName: thankYouReview.customerName,
                jobTypeName: thankYouReview.jobTypeName,
                jobLocationZip: thankYouReview.jobLocationZip,
                contractorName: user?.fullName || user?.firstName || undefined,
                contractorBusiness: profile.businessName || undefined,
                highlights,
              })
            }}
          />
        )}

        {invoiceEdit && (
          <InvoiceEditModal
            invoice={invoiceEdit}
            onClose={() => setInvoiceEdit(null)}
            onDone={(updated) => { setInvoiceEdit(null); setInvoiceShare(updated) }}
            onRegenerate={async (subtotal, amountPaid, paymentMethods) => {
              const clerkToken = await getToken()
              if (!clerkToken) throw new Error('Not signed in')
              return regenerateInvoiceCopy({
                clerkToken,
                customerName: invoiceEdit.customerName,
                jobTypeName: invoiceEdit.jobTypeName,
                businessName: profile.businessName || undefined,
                contractorName: user?.fullName || user?.firstName || undefined,
                subtotal,
                amountPaid,
                dueInDays: 14,
                paymentMethods: paymentMethods || undefined,
              })
            }}
          />
        )}

        {invoiceShare && (
          <ShareInvoiceModal
            invoice={invoiceShare}
            fromName={user?.fullName || user?.firstName || undefined}
            onClose={() => setInvoiceShare(null)}
          />
        )}

        {estimatePreview && (
          <EstimatePreview
            estimate={estimatePreview}
            onClose={() => setEstimatePreview(null)}
            onSaved={(updated) => {
              setEstimates(prev => prev.map(e => e.id === updated.id ? updated : e))
              setEstimatePreview(updated)
            }}
            onPrint={(est) => openEstimatePrintWindow(est, profile)}
            businessName={profile.businessName}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: '#1a1f2e', letterSpacing: '-0.5px' }}>
            {viewMode === 'completed' ? '📦 Completed Jobs' : viewMode === 'declined' ? '❌ Declined Estimates' : '🗂️ Projects'}
          </h2>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>
            {viewMode === 'completed'
              ? 'Archived finished jobs — kept for records. Restore to active or delete permanently.'
              : viewMode === 'declined'
                ? 'Estimates the customer declined. Kept for your records — delete any you no longer need.'
                : 'Lead → estimated → contracted → in progress → completed. Each project rolls up estimates, change orders, and photos.'}
          </p>
        </div>
        {viewMode === 'active' && (
          <button onClick={() => setShowForm(!showForm)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '12px 22px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', boxShadow: '0 2px 8px rgba(249,115,22,0.25)' }}>
            {showForm ? '✕ Cancel' : '+ New Project'}
          </button>
        )}
      </div>

      {/* Search box — find any job fast by customer, type, ZIP, or notes */}
      <div style={{ position: 'relative', marginBottom: '12px' }}>
        <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: '15px' }}>🔍</span>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by customer, job type, ZIP…"
          style={{ width: '100%', padding: '11px 12px 11px 38px', border: '1px solid #cbd5e1', borderRadius: '10px', fontSize: '15px', boxSizing: 'border-box' }}
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: '#f1f5f9', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px', color: '#64748b', fontWeight: 600 }}>Clear</button>
        )}
      </div>

      {/* Active / Completed / Declined toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button
          onClick={() => { setViewMode('active'); setStatusFilter('all') }}
          style={{ padding: '8px 16px', border: viewMode === 'active' ? '2px solid #f97316' : '1px solid #e2e8f0', background: viewMode === 'active' ? '#fff7ed' : 'white', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}
        >
          🗂️ Active ({projects.filter(p => !p.archived && !p.declined).length})
        </button>
        <button
          onClick={() => { setViewMode('completed'); setStatusFilter('all') }}
          style={{ padding: '8px 16px', border: viewMode === 'completed' ? '2px solid #1a1f2e' : '1px solid #e2e8f0', background: viewMode === 'completed' ? '#1a1f2e' : 'white', color: viewMode === 'completed' ? 'white' : '#1a1f2e', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}
        >
          📦 Completed ({archivedCount})
        </button>
        <button
          onClick={() => { setViewMode('declined'); setStatusFilter('all') }}
          style={{ padding: '8px 16px', border: viewMode === 'declined' ? '2px solid #dc2626' : '1px solid #e2e8f0', background: viewMode === 'declined' ? '#fef2f2' : 'white', color: viewMode === 'declined' ? '#dc2626' : '#1a1f2e', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}
        >
          ❌ Declined ({declinedCount})
        </button>
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
            <div key={p.id} onClick={() => setActiveId(p.id)} style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', cursor: 'pointer', borderLeft: `4px solid ${sc.text}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <h3 style={{ fontWeight: 700, fontSize: '16px' }}>{p.customerName}</h3>
                  <p style={{ color: '#64748b', fontSize: '13px', marginTop: '2px' }}>{p.jobTypeName}{p.jobLocationZip && ` · ${p.jobLocationZip}`}</p>
                  <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>
                    {agg.ests.length} estimate(s) · {agg.cos.length} change order(s)
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
