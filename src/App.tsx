import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react'
import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import Customers from './Customers'
import Settings, { fetchBusinessName } from './Settings'
import ScanRoom from './ScanRoom'
import Projects from './Projects'
import Estimates from './Estimates'
import PublicEstimate from './PublicEstimate'
import PublicPhotoLog from './PublicPhotoLog'
import PublicChangeOrder from './PublicChangeOrder'
import PublicThankYou from './PublicThankYou'
import PublicInvoice from './PublicInvoice'
import { autoConvertApprovedEstimates } from './lib/autoConvertEstimates'
import { useFirebaseBridge } from './lib/useFirebaseBridge'
import BusinessOnboarding from './BusinessOnboarding'
import QuickPhotoCapture from './QuickPhotoCapture'
import type { ProjectStatus } from './data/types'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

function useDashboardCounts(userId: string | undefined) {
  const [counts, setCounts] = useState({ activeJobs: 0, pendingEstimates: 0, customers: 0 })
  useEffect(() => {
    if (!userId) { setCounts({ activeJobs: 0, pendingEstimates: 0, customers: 0 }); return }
    (async () => {
      try {
        const [projects, estimates, customers] = await Promise.all([
          getDocs(query(collection(db, 'projects'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'estimates'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'customers'), where('createdBy', '==', userId))),
        ])
        // "Active" = anything in flight: estimated, contracted, or in_progress.
        const activeStatuses = new Set(['estimated', 'contracted', 'in_progress'])
        const activeJobs = projects.docs.filter(d => activeStatuses.has(d.data().status as string)).length
        const pendingEstimates = estimates.docs.filter(d => (d.data().status as string) === 'pending').length
        setCounts({ activeJobs, pendingEstimates, customers: customers.size })
      } catch (err) {
        console.error('Dashboard counts failed:', err)
      }
    })()
  }, [userId])
  return counts
}

interface Tile {
  key: string
  label: string
  icon: string
  blurb: string
}

const TILES: Tile[] = [
  { key: 'scan-room',     label: 'Quick Quote',   icon: '⚡', blurb: 'Photos + voice → instant quote' },
  { key: 'projects',      label: 'Projects',      icon: '🗂️', blurb: 'Quotes, change orders, photos — all in one place' },
  { key: 'customers',     label: 'Customers',     icon: '👥', blurb: 'Profiles, photos, history' },
]

// Sidebar shows the dashboard tiles + Estimates + a Settings entry at the
// bottom. Estimates isn't a dashboard tile (the Pending Estimates box links
// there) but belongs in the nav for direct access.
const NAV_ITEMS: Tile[] = [
  ...TILES,
  { key: 'estimates', label: 'Estimates', icon: '📝', blurb: 'Pending, approved & declined' },
  { key: 'settings', label: 'Settings', icon: '⚙️', blurb: 'Business profile' },
]

const TITLE_MAP: Record<string, string> = {
  dashboard: 'Dashboard',
  estimates: 'Estimates',
  ...Object.fromEntries(TILES.map(t => [t.key, t.label])),
}

function DashboardHome({ counts, onPick, onBox, onPhotos, userName }: { counts: ReturnType<typeof useDashboardCounts>; onPick: (key: string) => void; onBox: (key: string, filter: ProjectStatus | 'all') => void; onPhotos: () => void; userName?: string }) {
  const isMobile = useIsMobile()
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const counterRow: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(3, 1fr)',
    gap: isMobile ? '8px' : '16px',
    marginBottom: isMobile ? '20px' : '32px',
  }
  const counterCard: React.CSSProperties = {
    background: 'white',
    padding: isMobile ? '12px' : '20px',
    borderRadius: '12px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    textAlign: 'center',
  }
  const counterValue: React.CSSProperties = { fontSize: isMobile ? '24px' : '32px', fontWeight: 700, color: ORANGE, lineHeight: 1.1 }
  const counterLabel: React.CSSProperties = { color: '#64748b', fontSize: isMobile ? '11px' : '13px', marginTop: '4px' }

  return (
    <div style={{ padding: isMobile ? '16px' : '32px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ marginBottom: isMobile ? '20px' : '28px' }}>
        <h1 style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 800, margin: '0 0 4px', color: NAVY, letterSpacing: '-0.5px' }}>
          {greeting}{userName ? `, ${userName}` : ''}.
        </h1>
        <p style={{ margin: 0, color: '#64748b', fontSize: isMobile ? '14px' : '15px' }}>Here's where things stand today.</p>
      </div>
      <div style={counterRow}>
        <button
          onClick={() => onBox('projects', 'in_progress')}
          style={{ ...counterCard, border: '2px solid transparent', cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE }}
          onMouseOut={e => { e.currentTarget.style.borderColor = 'transparent' }}
          title="View active jobs"
        >
          <div style={counterValue}>{counts.activeJobs}</div>
          <div style={counterLabel}>Active Jobs ›</div>
        </button>
        <button
          onClick={() => onPick('estimates')}
          style={{ ...counterCard, border: '2px solid transparent', cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE }}
          onMouseOut={e => { e.currentTarget.style.borderColor = 'transparent' }}
          title="View pending estimates"
        >
          <div style={counterValue}>{counts.pendingEstimates}</div>
          <div style={counterLabel}>Pending Estimates ›</div>
        </button>
        <button
          onClick={() => onPick('customers')}
          style={{ ...counterCard, border: '2px solid transparent', cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE }}
          onMouseOut={e => { e.currentTarget.style.borderColor = 'transparent' }}
          title="View customers"
        >
          <div style={counterValue}>{counts.customers}</div>
          <div style={counterLabel}>Customers ›</div>
        </button>
      </div>

      <h2 style={{ fontSize: isMobile ? '16px' : '18px', fontWeight: 700, marginBottom: '12px', color: NAVY, textTransform: 'uppercase', letterSpacing: '1px' }}>What do you want to do?</h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
        gap: isMobile ? '12px' : '20px',
      }}>
        {[...TILES, { key: 'photo-capture', label: 'Job Photos', icon: '📸', blurb: 'Snap photos on site — saved to the job & thank-you letter' }].map(t => (
          <button
            key={t.key}
            onClick={() => t.key === 'photo-capture' ? onPhotos() : onPick(t.key)}
            style={{
              background: 'white',
              border: '2px solid transparent',
              borderRadius: '14px',
              padding: isMobile ? '20px 12px' : '28px 20px',
              cursor: 'pointer',
              textAlign: 'left',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
              transition: 'transform 0.1s, border-color 0.1s',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              minHeight: isMobile ? '120px' : '140px',
            }}
            onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-2px)' }}
            onMouseOut={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.transform = 'translateY(0)' }}
          >
            <div style={{ fontSize: isMobile ? '32px' : '40px', lineHeight: 1 }}>{t.icon}</div>
            <div style={{ fontWeight: 700, fontSize: isMobile ? '15px' : '17px', color: NAVY }}>{t.label}</div>
            <div style={{ fontSize: isMobile ? '12px' : '13px', color: '#64748b', lineHeight: 1.3 }}>{t.blurb}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// Establishes the Firebase session (bridged from Clerk) BEFORE mounting the
// Dashboard, so no Firestore/Storage call fires until Security Rules can
// authorize it. Until then we show a brief loading state.
function FirebaseGate() {
  const { ready, error } = useFirebaseBridge()
  const { user } = useUser()
  // null = still checking; true/false = whether the user needs onboarding.
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null)

  useEffect(() => {
    if (!ready || !user?.id) return
    let cancelled = false
    fetchBusinessName(user.id).then(name => {
      if (!cancelled) setNeedsOnboarding(!name.trim())
    }).catch(() => { if (!cancelled) setNeedsOnboarding(false) })
    return () => { cancelled = true }
  }, [ready, user?.id])

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f8fafc', padding: '24px' }}>
        <div style={{ textAlign: 'center', maxWidth: '420px' }}>
          <p style={{ fontSize: '15px', color: '#dc2626', fontWeight: 600 }}>⚠ Couldn't establish a secure session.</p>
          <p style={{ fontSize: '13px', color: '#64748b' }}>{error}</p>
          <button onClick={() => window.location.reload()} style={{ marginTop: '12px', background: ORANGE, color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>Reload</button>
        </div>
      </div>
    )
  }
  if (!ready || needsOnboarding === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f8fafc' }}>
        <div style={{ textAlign: 'center', color: '#64748b' }}>
          <div style={{ width: '32px', height: '32px', border: '3px solid #e2e8f0', borderTopColor: ORANGE, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <p style={{ fontSize: '14px' }}>Securing your session…</p>
        </div>
      </div>
    )
  }
  if (needsOnboarding) {
    return <BusinessOnboarding onDone={() => setNeedsOnboarding(false)} />
  }
  return <Dashboard />
}

function Dashboard() {
  const { user } = useUser()
  const [page, setPage] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  // When the dashboard boxes deep-link into Projects, this seeds its status filter.
  const [projectsFilter, setProjectsFilter] = useState<ProjectStatus | 'all'>('all')
  const counts = useDashboardCounts(user?.id)
  const isMobile = useIsMobile()
  const [conversionToast, setConversionToast] = useState<string | null>(null)
  const [photoCaptureOpen, setPhotoCaptureOpen] = useState(false)
  const [businessNameBannerDismissed, setBusinessNameBannerDismissed] = useState(false)
  const [showBusinessNameBanner, setShowBusinessNameBanner] = useState(false)

  // On sign-in / refresh, sweep for approved estimates that haven't yet been
  // converted to a Project and create them. This is how the public-facing
  // accept flow "lands" in the contractor's app — the customer can't write
  // projects directly, so we lazy-convert here.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    let running = false

    const runSweep = () => {
      // Guard against overlapping runs — the reconcile writes to Firestore,
      // which would re-trigger the snapshot and could loop.
      if (running || cancelled) return
      running = true
      autoConvertApprovedEstimates(user.id).then(result => {
        if (cancelled) return
        if (result.created > 0) {
          const parts: string[] = []
          if (result.approvedCount > 0) parts.push(`✅ ${result.approvedCount} estimate${result.approvedCount === 1 ? '' : 's'} APPROVED — auto-moved to In Progress`)
          if (result.declinedCount > 0) parts.push(`❌ ${result.declinedCount} declined → Declined folder`)
          const otherCount = result.created - result.approvedCount - result.declinedCount
          if (otherCount > 0) parts.push(`📋 ${otherCount} estimate${otherCount === 1 ? '' : 's'} → project${otherCount === 1 ? '' : 's'}`)
          setConversionToast(parts.join(' · ') || `${result.created} estimate${result.created === 1 ? '' : 's'} synced to Projects.`)
          setTimeout(() => setConversionToast(null), 9000)
        }
      }).catch(err => console.error('Auto-convert sweep failed:', err))
        .finally(() => { running = false })
    }

    // Live subscription: when a customer approves/declines via the public share
    // link, the estimate doc changes → this fires → the project advances and the
    // toast pops, with no refresh needed. Also covers the initial load.
    const unsub = onSnapshot(
      query(collection(db, 'estimates'), where('createdBy', '==', user.id)),
      () => runSweep(),
      err => console.error('Estimate listener failed:', err),
    )

    return () => { cancelled = true; unsub() }
  }, [user?.id])

  // Notify the contractor when a customer approves/declines a CHANGE ORDER.
  // The CO doc gains a customerResponse + flips status — we watch for that
  // transition and pop a toast. Approved COs also automatically fold into the
  // project's Contract Total (the Projects listener handles the rebuild), so
  // the "updated version from the original with the change accepted" lands
  // without a refresh. Tracked IDs prevent re-toasting on reload.
  useEffect(() => {
    if (!user?.id) return
    const notifiedKey = `bp_co_notified_${user.id}`
    let notified: Set<string>
    try {
      notified = new Set(JSON.parse(window.sessionStorage?.getItem(notifiedKey) || '[]') as string[])
    } catch {
      notified = new Set()
    }
    // Skip the first snapshot so we don't toast for every pre-existing decision
    // on load. We only want toasts for NEW decisions arriving live.
    let primed = false
    const unsub = onSnapshot(
      query(collection(db, 'changeOrders'), where('createdBy', '==', user.id)),
      snap => {
        const newlyDecided: { customerName: string; action: 'approved' | 'declined'; delta: number }[] = []
        snap.docs.forEach(d => {
          const data = d.data() as { customerName?: string; customerResponse?: { action?: string }; status?: string; delta?: number }
          const decided = data.status === 'approved' || data.status === 'declined'
          if (decided && !notified.has(d.id)) {
            if (primed) newlyDecided.push({
              customerName: data.customerName || 'a customer',
              action: data.status as 'approved' | 'declined',
              delta: Number(data.delta) || 0,
            })
            notified.add(d.id)
          }
        })
        if (newlyDecided.length > 0) {
          const msg = newlyDecided.map(n => n.action === 'approved'
            ? `✅ ${n.customerName} APPROVED a change order (${n.delta >= 0 ? '+' : '−'}$${Math.abs(n.delta).toFixed(2)}) — Contract Total updated.`
            : `❌ ${n.customerName} declined a change order.`).join(' · ')
          setConversionToast(msg)
          setTimeout(() => setConversionToast(null), 9000)
        }
        try { window.sessionStorage?.setItem(notifiedKey, JSON.stringify(Array.from(notified))) } catch { /* noop */ }
        primed = true
      },
      err => console.error('Change-order notification listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  // Notify when a customer pays an invoice — by CARD (webhook flips status to
  // 'paid') or by CASH (customer taps "Pay Cash" on the share link). Clicking
  // the toast takes the contractor to Projects, where the project sits open
  // with the thank-you panel ready to send (the panel auto-opens on payment).
  useEffect(() => {
    if (!user?.id) return
    const notifiedKey = `bp_inv_notified_${user.id}`
    let notified: Set<string>
    try {
      notified = new Set(JSON.parse(window.sessionStorage?.getItem(notifiedKey) || '[]') as string[])
    } catch {
      notified = new Set()
    }
    let primed = false
    const unsub = onSnapshot(
      query(collection(db, 'invoices'), where('createdBy', '==', user.id)),
      snap => {
        const events: { customerName: string; mode: 'card' | 'cash'; projectId?: string }[] = []
        snap.docs.forEach(d => {
          const data = d.data() as { customerName?: string; status?: string; customerCashChoice?: boolean; projectId?: string }
          // Two distinct events per invoice: paid (card) and cashChoice. Track
          // each separately so picking cash AND later paying still fires once
          // each (rare, but possible).
          if (data.status === 'paid') {
            const key = `${d.id}:paid`
            if (!notified.has(key)) {
              if (primed) events.push({ customerName: data.customerName || 'a customer', mode: 'card', projectId: data.projectId })
              notified.add(key)
            }
          }
          if (data.customerCashChoice) {
            const key = `${d.id}:cash`
            if (!notified.has(key)) {
              if (primed) events.push({ customerName: data.customerName || 'a customer', mode: 'cash', projectId: data.projectId })
              notified.add(key)
            }
          }
        })
        // Queue the first event's projectId so Projects can auto-open the
        // thank-you flow for it when the user taps the toast (or navigates).
        const firstWithProject = events.find(e => e.projectId)
        if (firstWithProject?.projectId) {
          // User-scope the key so a different contractor signing in on the
          // same browser doesn't get hit with another user's pending signal.
          try { window.sessionStorage?.setItem(`bp_open_thanks_for_project_${user.id}`, firstWithProject.projectId) } catch { /* noop */ }
        }
        if (events.length > 0) {
          const msg = events.map(e => e.mode === 'card'
            ? `💳 ${e.customerName} paid by card — tap to send a thank-you.`
            : `💵 ${e.customerName} will pay in cash — tap to send a thank-you.`).join(' · ')
          setConversionToast(msg)
          setTimeout(() => setConversionToast(null), 12000)
        }
        try { window.sessionStorage?.setItem(notifiedKey, JSON.stringify(Array.from(notified))) } catch { /* noop */ }
        primed = true
      },
      err => console.error('Invoice notification listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  // Detect return from Stripe subscription Checkout (?billing=success|cancel)
  // and show a toast. The webhook flips the tier; the Settings page reflects it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const billing = params.get('billing')
    if (billing === 'success') {
      setConversionToast('💎 Welcome to BuildPro+ Pro — unlimited instant quotes unlocked!')
      setTimeout(() => setConversionToast(null), 9000)
    } else if (billing === 'cancel') {
      setConversionToast('Upgrade canceled — you can subscribe anytime in Settings.')
      setTimeout(() => setConversionToast(null), 6000)
    }
    if (billing) window.history.replaceState({}, '', window.location.pathname)
  }, [])

  // Check whether the user has set a business name yet. If not, show the
  // soft onboarding banner on the dashboard.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    const dismissedKey = `bp_business_banner_dismissed_${user.id}`
    if (typeof window !== 'undefined' && window.sessionStorage?.getItem(dismissedKey) === '1') {
      setBusinessNameBannerDismissed(true)
      return
    }
    fetchBusinessName(user.id).then(name => {
      if (cancelled) return
      if (!name.trim()) setShowBusinessNameBanner(true)
    })
    return () => { cancelled = true }
  }, [user?.id])

  const dismissBusinessNameBanner = () => {
    setBusinessNameBannerDismissed(true)
    if (user?.id && typeof window !== 'undefined') {
      try { window.sessionStorage.setItem(`bp_business_banner_dismissed_${user.id}`, '1') } catch {}
    }
  }

  const go = (key: string) => {
    // Reset the Projects filter when navigating via the sidebar/tiles so you
    // don't land on a stale deep-linked filter from a dashboard box.
    if (key === 'projects') setProjectsFilter('all')
    setPage(key)
    setMenuOpen(false)
  }
  // Navigate to a page AND seed a Projects status filter (used by the
  // clickable dashboard summary boxes).
  const goWithFilter = (key: string, filter: ProjectStatus | 'all') => {
    setProjectsFilter(filter)
    setPage(key)
    setMenuOpen(false)
  }

  const navItem = (label: string, icon: string, key: string) => (
    <a onClick={() => go(key)} style={{
      color: page === key ? ORANGE : 'white',
      textDecoration: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 14px',
      borderRadius: '8px',
      background: page === key ? 'rgba(249,115,22,0.15)' : 'transparent',
      fontSize: '14px',
      fontWeight: 500,
    }}>
      {icon} {label}
    </a>
  )

  const sidebar = (
    <div style={{
      width: isMobile ? '100%' : '240px',
      background: NAVY,
      color: 'white',
      padding: isMobile ? '16px' : '24px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      overflowY: 'auto',
      maxHeight: isMobile ? '100vh' : '100vh',
      position: isMobile ? 'fixed' : 'static',
      top: 0, left: 0,
      height: isMobile ? '100vh' : 'auto',
      zIndex: 100,
      transform: isMobile ? (menuOpen ? 'translateX(0)' : 'translateX(-100%)') : 'none',
      transition: 'transform 0.2s',
      boxShadow: isMobile ? '2px 0 8px rgba(0,0,0,0.2)' : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', padding: '0 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '32px', height: '32px', background: ORANGE, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: 800, color: 'white' }}>B</div>
          <div>
            <h2 style={{ color: 'white', fontSize: '15px', margin: 0, lineHeight: 1.1, fontWeight: 700 }}>BuildPro<span style={{ color: ORANGE }}>+</span></h2>
            <p style={{ color: '#94a3b8', fontSize: '10px', margin: '2px 0 0', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Contractor Suite</p>
          </div>
        </div>
        {isMobile && <button onClick={() => setMenuOpen(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '24px', cursor: 'pointer', lineHeight: 1 }}>×</button>}
      </div>
      {navItem('Dashboard', '🏠', 'dashboard')}
      {NAV_ITEMS.map(t => navItem(t.label, t.icon, t.key))}
    </div>
  )

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {sidebar}
      {isMobile && menuOpen && (
        <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 99 }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          background: 'white',
          padding: isMobile ? '12px 16px' : '16px 32px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid #e2e8f0',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {isMobile && (
              <button onClick={() => setMenuOpen(true)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}>☰</button>
            )}
            {page !== 'dashboard' && (
              <button onClick={() => go('dashboard')} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', color: '#1a1f2e', whiteSpace: 'nowrap' }}>
                ← Dashboard
              </button>
            )}
            <h1 style={{ fontSize: isMobile ? '16px' : '20px', fontWeight: 600, margin: 0 }}>{TITLE_MAP[page] ?? page}</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {!isMobile && <span style={{ color: '#64748b' }}>Welcome, {user?.firstName}!</span>}
            <UserButton />
          </div>
        </div>

        {photoCaptureOpen && <QuickPhotoCapture onClose={() => setPhotoCaptureOpen(false)} />}

        {conversionToast && (
          <div
            onClick={() => { setConversionToast(null); go('projects') }}
            style={{
              position: 'fixed',
              top: 'max(16px, env(safe-area-inset-top, 16px))',
              right: '16px',
              left: isMobile ? '16px' : 'auto',
              maxWidth: isMobile ? undefined : '420px',
              background: '#1a1f2e',
              color: 'white',
              padding: '14px 18px',
              borderRadius: '10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              borderLeft: `4px solid ${ORANGE}`,
              fontSize: '14px',
              fontWeight: 600,
              zIndex: 250,
              cursor: 'pointer',
              animation: 'slideInRight 0.3s ease-out',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '12px' }}>
              <span>{conversionToast}</span>
              <button onClick={e => { e.stopPropagation(); setConversionToast(null) }} style={{ background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer', fontSize: '16px', padding: 0, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#94a3b8', fontWeight: 400 }}>Tap to open Projects →</div>
          </div>
        )}

        {page === 'dashboard' && (
          <>
            {showBusinessNameBanner && !businessNameBannerDismissed && (
              <div style={{ maxWidth: '1100px', margin: `${isMobile ? '12px 16px 0' : '20px 32px 0'}`, marginLeft: 'auto', marginRight: 'auto', padding: isMobile ? '0 16px' : '0 32px' }}>
                <div style={{ background: 'linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%)', border: '1px solid #fed7aa', borderRadius: '12px', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', boxShadow: '0 1px 3px rgba(249,115,22,0.1)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: '0 0 2px', fontWeight: 700, color: NAVY, fontSize: '14px' }}>👋 Welcome to BuildPro+! Add your business name.</p>
                    <p style={{ margin: 0, color: '#92400e', fontSize: '13px' }}>Customers see it on letters, estimates, and thank-you packages.</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => go('settings')} style={{ background: ORANGE, color: 'white', border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}>
                      Set Business Name
                    </button>
                    <button onClick={dismissBusinessNameBanner} style={{ background: 'transparent', color: '#92400e', border: 'none', padding: '8px 10px', cursor: 'pointer', fontSize: '20px', lineHeight: 1 }} title="Dismiss">
                      ×
                    </button>
                  </div>
                </div>
              </div>
            )}
            <DashboardHome counts={counts} onPick={go} onBox={goWithFilter} onPhotos={() => setPhotoCaptureOpen(true)} userName={user?.firstName || undefined} />
          </>
        )}
        {page === 'projects' && <Projects key={projectsFilter} initialStatusFilter={projectsFilter} />}
        {page === 'estimates' && <Estimates />}
        {page === 'customers' && <Customers />}
        {page === 'scan-room' && <ScanRoom onNavigate={go} />}
        {page === 'settings' && <Settings />}
      </div>
    </div>
  )
}

// Match /q/<id> — public estimate viewer that doesn't require sign-in.
function publicEstimateIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/q\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

// Match /log/<customerId> — public photo log viewer.
function publicPhotoLogIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/log\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

// Match /co/<id> — public change order viewer.
function publicChangeOrderIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/co\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

// Match /thanks/<id> — public thank-you package viewer.
function publicThankYouIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/thanks\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

// Match /inv/<id> — public invoice viewer.
function publicInvoiceIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/inv\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

function App() {
  const publicEstimateId = publicEstimateIdFromUrl()
  if (publicEstimateId) return <PublicEstimate estimateId={publicEstimateId} />

  const publicLogId = publicPhotoLogIdFromUrl()
  if (publicLogId) return <PublicPhotoLog customerId={publicLogId} />

  const publicCoId = publicChangeOrderIdFromUrl()
  if (publicCoId) return <PublicChangeOrder changeOrderId={publicCoId} />

  const publicThxId = publicThankYouIdFromUrl()
  if (publicThxId) return <PublicThankYou packageId={publicThxId} />

  const publicInvId = publicInvoiceIdFromUrl()
  if (publicInvId) return <PublicInvoice invoiceId={publicInvId} />

  return (
    <div>
      <SignedOut>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: `linear-gradient(135deg, ${NAVY} 0%, #0f172a 100%)`, padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'white', maxWidth: '480px' }}>
            <div style={{ width: '72px', height: '72px', background: ORANGE, borderRadius: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '36px', fontWeight: 800, color: 'white', marginBottom: '20px', boxShadow: '0 8px 24px rgba(249,115,22,0.4)' }}>B</div>
            <h1 style={{ fontSize: '48px', marginBottom: '8px', lineHeight: 1.1, fontWeight: 800, letterSpacing: '-1px' }}>
              BuildPro<span style={{ color: ORANGE }}>+</span>
            </h1>
            <p style={{ margin: '0 0 8px', color: ORANGE, fontSize: '14px', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 700 }}>Contractor Suite</p>
            <p style={{ marginBottom: '36px', color: '#94a3b8', fontSize: '16px', lineHeight: 1.5 }}>Quick instant quotes, customer e-sign, change orders, and photo project tracking — built for working contractors.</p>
            <SignInButton mode="modal">
              <button style={{ background: ORANGE, color: 'white', border: 'none', padding: '16px 36px', borderRadius: '10px', fontSize: '16px', cursor: 'pointer', fontWeight: 700, boxShadow: '0 4px 12px rgba(249,115,22,0.3)' }}>
                Sign In to Get Started →
              </button>
            </SignInButton>
            <div style={{ marginTop: '40px', display: 'flex', justifyContent: 'center', gap: '24px', color: '#64748b', fontSize: '12px', flexWrap: 'wrap' }}>
              <span>⚡ Quick Quote</span>
              <span>🗂️ Projects</span>
              <span>🔄 Change Orders</span>
              <span>📸 Photo Logs</span>
            </div>
            <p style={{ marginTop: '32px', fontSize: '11px', color: '#475569' }}>
              📱 Tip: Add this app to your home screen for one-tap access — Safari Share → Add to Home Screen, or Chrome menu → Install app.
            </p>
          </div>
        </div>
      </SignedOut>
      <SignedIn>
        <FirebaseGate />
      </SignedIn>
    </div>
  )
}

export default App
