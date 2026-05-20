import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react'
import { useState, useEffect } from 'react'
import { collection, getCountFromServer, query, where } from 'firebase/firestore'
import { db } from './firebase'
import Customers from './Customers'
import Estimates from './Estimates'
import ScanRoom from './ScanRoom'
import MaterialsPricing from './MaterialsPricing'
import Rentals from './Rentals'
import Projects from './Projects'

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
        const [jobs, estimates, customers] = await Promise.all([
          getCountFromServer(query(collection(db, 'projects'), where('createdBy', '==', userId), where('status', '==', 'active'))),
          getCountFromServer(query(collection(db, 'estimates'), where('createdBy', '==', userId), where('status', '==', 'pending'))),
          getCountFromServer(query(collection(db, 'customers'), where('createdBy', '==', userId))),
        ])
        setCounts({
          activeJobs: jobs.data().count,
          pendingEstimates: estimates.data().count,
          customers: customers.data().count,
        })
      } catch {}
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
  { key: 'scan-room',     label: 'Scan Room',     icon: '📐', blurb: 'Photos + voice → AI estimate' },
  { key: 'estimates',     label: 'Estimates',     icon: '📝', blurb: 'Create & manage quotes' },
  { key: 'projects',      label: 'Projects',      icon: '🗂️', blurb: 'Lead to closeout' },
  { key: 'customers',     label: 'Customers',     icon: '👥', blurb: 'Client directory' },
]

const NAV_ITEMS = TILES // sidebar shows the same set as the dashboard tiles

const TITLE_MAP: Record<string, string> = {
  dashboard: 'Dashboard',
  ...Object.fromEntries(TILES.map(t => [t.key, t.label])),
  materials: 'Materials Pricing',
  rentals: 'Rental Equipment',
}

function DashboardHome({ counts, onPick }: { counts: ReturnType<typeof useDashboardCounts>; onPick: (key: string) => void }) {
  const isMobile = useIsMobile()
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
      <div style={counterRow}>
        <div style={counterCard}><div style={counterValue}>{counts.activeJobs}</div><div style={counterLabel}>Active Jobs</div></div>
        <div style={counterCard}><div style={counterValue}>{counts.pendingEstimates}</div><div style={counterLabel}>Pending Estimates</div></div>
        <div style={counterCard}><div style={counterValue}>{counts.customers}</div><div style={counterLabel}>Customers</div></div>
      </div>

      <h2 style={{ fontSize: isMobile ? '18px' : '20px', fontWeight: 700, marginBottom: '12px', color: '#1a1f2e' }}>What do you want to do?</h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
        gap: isMobile ? '12px' : '20px',
      }}>
        {TILES.map(t => (
          <button
            key={t.key}
            onClick={() => onPick(t.key)}
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

function Dashboard() {
  const { user } = useUser()
  const [page, setPage] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const counts = useDashboardCounts(user?.id)
  const isMobile = useIsMobile()

  const go = (key: string) => { setPage(key); setMenuOpen(false) }

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
        <h2 style={{ color: ORANGE, fontSize: '18px', margin: 0 }}>Contractors Office</h2>
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

      <div style={{ flex: 1, background: '#f8fafc', minWidth: 0 }}>
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
            <h1 style={{ fontSize: isMobile ? '16px' : '20px', fontWeight: 600, margin: 0 }}>{TITLE_MAP[page] ?? page}</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {!isMobile && <span style={{ color: '#64748b' }}>Welcome, {user?.firstName}!</span>}
            <UserButton />
          </div>
        </div>

        {page === 'dashboard' && <DashboardHome counts={counts} onPick={go} />}
        {page === 'projects' && <Projects />}
        {page === 'customers' && <Customers />}
        {page === 'scan-room' && <ScanRoom />}
        {page === 'estimates' && <Estimates />}
        {page === 'materials' && <MaterialsPricing />}
        {page === 'rentals' && <Rentals />}
      </div>
    </div>
  )
}

function App() {
  return (
    <div>
      <SignedOut>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: NAVY, padding: '20px' }}>
          <div style={{ textAlign: 'center', color: 'white', maxWidth: '420px' }}>
            <h1 style={{ fontSize: '40px', color: ORANGE, marginBottom: '12px', lineHeight: 1.1 }}>Contractors Office</h1>
            <p style={{ marginBottom: '32px', color: '#94a3b8', fontSize: '15px' }}>Your AI-powered business platform</p>
            <SignInButton mode="modal">
              <button style={{ background: ORANGE, color: 'white', border: 'none', padding: '14px 32px', borderRadius: '8px', fontSize: '16px', cursor: 'pointer', fontWeight: 600 }}>
                Sign In to Get Started
              </button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>
      <SignedIn>
        <Dashboard />
      </SignedIn>
    </div>
  )
}

export default App
