import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react'
import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import Customers from './Customers'
import Settings, { fetchBusinessName } from './Settings'
import ScanRoom from './ScanRoom'
import Projects from './Projects'
import Estimates from './Estimates'
import Schedule from './Schedule'
import PublicEstimate from './PublicEstimate'
import PublicPhotoLog from './PublicPhotoLog'
import PublicChangeOrder from './PublicChangeOrder'
import PublicThankYou from './PublicThankYou'
import PublicInvoice from './PublicInvoice'
import { autoConvertApprovedEstimates } from './lib/autoConvertEstimates'
import { useFirebaseBridge } from './lib/useFirebaseBridge'
import BusinessOnboarding from './BusinessOnboarding'
import QuickPhotoCapture from './QuickPhotoCapture'
import QuickAddVoice from './QuickAddVoice'
import WelcomeTour from './WelcomeTour'
import { TermsPage, PrivacyPage } from './LegalPages'
import { fireDueReminders, fireMorningAgenda, requestNotificationPermission, alertsEnabled, setAlertsEnabled, playAlertCue } from './lib/reminders'
import { tipOfTheDay } from './data/contractorTips'
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

interface DashboardData {
  activeJobs: number
  pendingEstimates: number
  customers: number
  // Stats
  revenueThisMonth: number      // sum of paid invoices this calendar month
  revenueThisWeek: number       // sum of paid invoices since Monday this week
  weeklyRevenue: { label: string; amount: number }[] // last 4 weeks (oldest→newest)
  estimatesWon: number          // approved estimates (all time)
  estimatesLost: number         // declined estimates (all time)
  avgJobSize: number            // avg approved estimate total
  // Needs attention — a unified reminder feed covering everything the
  // contractor might need to act on or be reminded about.
  attention: AttentionItem[]
}

type AttentionKind =
  | 'overdue_invoice'        // unpaid invoice past due date
  | 'unsent_invoice'         // invoice still in draft, never sent
  | 'cash_to_confirm'        // customer chose "pay cash" — confirm you got it
  | 'stale_estimate'         // estimate sent, no response in 3+ days
  | 'starting_soon'          // job start date is today/tomorrow
  | 'needs_completion'       // in-progress job started a while ago — likely done, nudge to mark complete
  | 'completed_no_invoice'   // project marked completed but no invoice created
  | 'date_change_requested'  // customer asked for a different start date
  | 'new_approval'           // estimate approved but no project/deposit action yet
  | 'calendar_event'         // a custom calendar event/reminder coming up
// Lower number = higher priority (sorts to top of the list).
const ATTENTION_PRIORITY: Record<AttentionKind, number> = {
  date_change_requested: 0,
  cash_to_confirm: 1,
  starting_soon: 2,
  calendar_event: 3,
  overdue_invoice: 4,
  completed_no_invoice: 5,
  needs_completion: 6,
  unsent_invoice: 7,
  stale_estimate: 8,
  new_approval: 9,
}
const ATTENTION_ICON: Record<AttentionKind, string> = {
  date_change_requested: '🗓️',
  cash_to_confirm: '💵',
  starting_soon: '📅',
  calendar_event: '🔔',
  overdue_invoice: '💸',
  completed_no_invoice: '🧾',
  needs_completion: '🏁',
  unsent_invoice: '📤',
  stale_estimate: '⏳',
  new_approval: '✅',
}
interface AttentionItem {
  id: string
  kind: AttentionKind
  label: string
  projectId?: string
  // Where tapping this reminder should take the contractor.
  goto?: 'projects' | 'estimates' | 'schedule'
  // For sorting time-sensitive items (yyyy-mm-dd of the relevant date).
  when?: string
}

// `refreshKey` lets the caller force a re-count when underlying data changes
// (the Dashboard bumps it from live onSnapshot listeners) so the tiles and the
// reminders feed stay current without a page reload.
function useDashboardCounts(userId: string | undefined, refreshKey = 0) {
  const [counts, setCounts] = useState<DashboardData>({
    activeJobs: 0, pendingEstimates: 0, customers: 0,
    revenueThisMonth: 0, revenueThisWeek: 0, weeklyRevenue: [], estimatesWon: 0, estimatesLost: 0, avgJobSize: 0, attention: [],
  })
  useEffect(() => {
    if (!userId) {
      setCounts({ activeJobs: 0, pendingEstimates: 0, customers: 0, revenueThisMonth: 0, revenueThisWeek: 0, weeklyRevenue: [], estimatesWon: 0, estimatesLost: 0, avgJobSize: 0, attention: [] })
      return
    }
    (async () => {
      try {
        const [projects, estimates, customers, invoices, calEvents] = await Promise.all([
          getDocs(query(collection(db, 'projects'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'estimates'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'customers'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'invoices'), where('createdBy', '==', userId))),
          getDocs(query(collection(db, 'calendarEvents'), where('createdBy', '==', userId))),
        ])
        const activeStatuses = new Set(['estimated', 'contracted', 'in_progress'])
        const activeJobs = projects.docs.filter(d => activeStatuses.has(d.data().status as string)).length
        const estDocs = estimates.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        const pendingEstimates = estDocs.filter(e => e.status === 'pending').length
        const won = estDocs.filter(e => e.status === 'approved')
        const lost = estDocs.filter(e => e.status === 'declined').length
        const avgJobSize = won.length > 0 ? +(won.reduce((s, e) => s + ((e.total as number) || 0), 0) / won.length).toFixed(0) : 0

        // Revenue this calendar month = paid invoices with paidAt in this month.
        const now = new Date()
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
        const invDocs = invoices.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        const paidInvoices = invDocs.filter(i => i.status === 'paid' && i.paidAt)
        const paidAtMs = (i: typeof invDocs[number]) => new Date(i.paidAt as string).getTime()
        const amountOf = (i: typeof invDocs[number]) => (i.subtotal as number) || 0
        const revenueThisMonth = +paidInvoices
          .filter(i => paidAtMs(i) >= monthStart)
          .reduce((s, i) => s + amountOf(i), 0).toFixed(2)

        // ── Weekly money: this week + the last 4 weeks (Monday-anchored). Helps
        //    the contractor see at a glance if cash is keeping up week to week. ──
        // Find the Monday 00:00 of the current week.
        const startOfWeek = (d: Date) => {
          const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
          const dow = (x.getDay() + 6) % 7   // 0 = Monday … 6 = Sunday
          x.setDate(x.getDate() - dow)
          return x
        }
        const thisMonday = startOfWeek(now)
        const revenueThisWeek = +paidInvoices
          .filter(i => paidAtMs(i) >= thisMonday.getTime())
          .reduce((s, i) => s + amountOf(i), 0).toFixed(2)
        // Build 4 buckets: 3 weeks ago → this week (oldest first).
        const weeklyRevenue: { label: string; amount: number }[] = []
        for (let w = 3; w >= 0; w--) {
          const weekStart = new Date(thisMonday); weekStart.setDate(weekStart.getDate() - w * 7)
          const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7)
          const amount = +paidInvoices
            .filter(i => { const t = paidAtMs(i); return t >= weekStart.getTime() && t < weekEnd.getTime() })
            .reduce((s, i) => s + amountOf(i), 0).toFixed(2)
          const label = w === 0 ? 'This wk' : weekStart.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
          weeklyRevenue.push({ label, amount })
        }

        // ── Needs attention: a unified reminder feed. Surfaces anything the
        //    contractor should act on so nothing slips through the cracks. ──
        const attention: AttentionItem[] = []
        const DAY = 86400000
        const todayStr = new Date().toISOString().slice(0, 10)
        const tomorrowStr = new Date(now.getTime() + DAY).toISOString().slice(0, 10)
        const projDocs = projects.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
        // Which projects already have an invoice? (so we can flag the ones that don't)
        const projectsWithInvoice = new Set(invDocs.map(i => i.projectId as string).filter(Boolean))

        // 1) Unpaid invoices past their due date.
        invDocs.filter(i => i.status !== 'paid' && !i.customerCashChoice && i.dueDate && new Date(i.dueDate as string).getTime() < now.getTime())
          .forEach(i => attention.push({
            id: `inv-${i.id}`, kind: 'overdue_invoice', goto: 'projects',
            label: `Invoice ${i.invoiceNumber || ''} for ${i.customerName || 'customer'} is past due ($${((i.amountDue as number) || 0).toFixed(2)})`,
            projectId: i.projectId as string | undefined,
            when: (i.dueDate as string)?.slice(0, 10),
          }))
        // 2) Customer chose "Pay Cash / In Person" — remind to confirm receipt.
        invDocs.filter(i => i.customerCashChoice && i.status !== 'paid')
          .forEach(i => attention.push({
            id: `cash-${i.id}`, kind: 'cash_to_confirm', goto: 'projects',
            label: `${i.customerName || 'A customer'} chose to pay cash for invoice ${i.invoiceNumber || ''} — confirm once you've collected $${((i.amountDue as number) || 0).toFixed(2)}`,
            projectId: i.projectId as string | undefined,
          }))
        // 3) Invoices created but never sent (still draft).
        invDocs.filter(i => i.status === 'draft')
          .forEach(i => attention.push({
            id: `draft-${i.id}`, kind: 'unsent_invoice', goto: 'projects',
            label: `Invoice ${i.invoiceNumber || ''} for ${i.customerName || 'customer'} is ready but hasn't been sent yet`,
            projectId: i.projectId as string | undefined,
          }))
        // 4) Estimates sent 3+ days ago with no customer response yet.
        estDocs.filter(e => e.status === 'pending' && e.createdAt && (now.getTime() - new Date(e.createdAt as string).getTime()) > 3 * DAY)
          .forEach(e => attention.push({
            id: `est-${e.id}`, kind: 'stale_estimate', goto: 'estimates',
            label: `${e.customerName || 'A customer'} hasn't responded to their estimate in ${Math.floor((now.getTime() - new Date(e.createdAt as string).getTime()) / DAY)} days`,
            projectId: e.projectId as string | undefined,
          }))
        // 5) Customer asked for a DIFFERENT start date — needs your decision.
        estDocs.filter(e => (e as { startDateResponse?: { action?: string; requestedDate?: string } }).startDateResponse?.action === 'requested_change')
          .forEach(e => {
            const sr = (e as { startDateResponse?: { requestedDate?: string } }).startDateResponse
            attention.push({
              id: `daterq-${e.id}`, kind: 'date_change_requested', goto: 'estimates',
              label: `${e.customerName || 'A customer'} requested a different start date${sr?.requestedDate ? ` (${new Date(sr.requestedDate + 'T12:00:00').toLocaleDateString()})` : ''} — review it`,
              projectId: e.projectId as string | undefined,
            })
          })
        // 6) Jobs scheduled to start today or tomorrow.
        projDocs.filter(p => !p.archived && !p.declined && p.status !== 'closed' && typeof p.startDate === 'string'
            && ((p.startDate as string).slice(0, 10) === todayStr || (p.startDate as string).slice(0, 10) === tomorrowStr))
          .forEach(p => {
            const when = (p.startDate as string).slice(0, 10) === todayStr ? 'today' : 'tomorrow'
            attention.push({
              id: `start-${p.id}`, kind: 'starting_soon', goto: 'schedule',
              label: `${p.jobTypeName || 'Job'} for ${p.customerName || 'customer'} starts ${when}`,
              projectId: p.id, when: (p.startDate as string).slice(0, 10),
            })
          })
        // 7) Project marked COMPLETED but no invoice has been created — remind to bill.
        projDocs.filter(p => p.status === 'completed' && !p.archived && !projectsWithInvoice.has(p.id))
          .forEach(p => attention.push({
            id: `noinv-${p.id}`, kind: 'completed_no_invoice', goto: 'projects',
            label: `${p.jobTypeName || 'Job'} for ${p.customerName || 'customer'} is marked complete — create the final invoice to get paid`,
            projectId: p.id,
          }))
        // 8) In-progress job whose start date passed 7+ days ago — likely done.
        //    Nudge to MARK IT COMPLETE (which unlocks the final invoice +
        //    thank-you), backing up the in-project "Mark Job Complete" banner so
        //    a finished job never quietly sits in progress and goes un-billed.
        projDocs.filter(p => p.status === 'in_progress' && !p.archived && typeof p.startDate === 'string'
            && (now.getTime() - new Date(p.startDate as string).getTime()) > 7 * DAY)
          .forEach(p => {
            const days = Math.floor((now.getTime() - new Date(p.startDate as string).getTime()) / DAY)
            attention.push({
              id: `done-${p.id}`, kind: 'needs_completion', goto: 'projects',
              label: `${p.jobTypeName || 'Job'} for ${p.customerName || 'customer'} started ${days} days ago — is it finished? Mark it complete to send the final invoice & thank-you`,
              projectId: p.id, when: (p.startDate as string).slice(0, 10),
            })
          })
        // 9) Custom calendar events/reminders that are due today or within their
        //    reminder window (or already today/overdue if no window set).
        calEvents.docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
          .forEach(ev => {
            const evDate = ev.date as string
            if (!evDate) return
            const daysUntil = Math.round((new Date(evDate + 'T12:00:00').getTime() - new Date(todayStr + 'T12:00:00').getTime()) / DAY)
            const window = typeof ev.remindDaysBefore === 'number' ? (ev.remindDaysBefore as number) : 0
            // Show it if it's today, inside its reminder lead time, OR overdue —
            // overdue items KEEP showing (up to 30 days back) so nothing the
            // contractor hasn't dealt with silently disappears.
            if (daysUntil <= window && daysUntil >= -30) {
              const whenTxt = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow'
                : daysUntil === -1 ? 'was yesterday' : daysUntil < -1 ? `${-daysUntil} days ago` : `in ${daysUntil} days`
              attention.push({
                id: `cal-${ev.id}`, kind: 'calendar_event', goto: 'schedule',
                label: `${(ev.kind === 'reminder') ? '🔔 ' : ''}${ev.title || 'Event'} — ${whenTxt}${ev.time ? ` at ${ev.time}` : ''}`,
                when: evDate,
              })
            }
          })

        // Sort: priority first, then soonest date.
        attention.sort((a, b) => {
          const pa = ATTENTION_PRIORITY[a.kind], pb = ATTENTION_PRIORITY[b.kind]
          if (pa !== pb) return pa - pb
          return (a.when || '9999').localeCompare(b.when || '9999')
        })

        // Pop browser notifications for the most time-sensitive reminders (once
        // per day each). Quiet no-op if the user hasn't enabled notifications.
        const NOTIFY_KINDS = new Set<AttentionKind>(['calendar_event', 'starting_soon', 'overdue_invoice', 'date_change_requested', 'cash_to_confirm'])
        fireDueReminders(attention.filter(a => NOTIFY_KINDS.has(a.kind)).map(a => ({ id: a.id, label: a.label })))

        // The in-app "6am morning-of" agenda: one consolidated pop-up listing
        // everything scheduled for TODAY (jobs starting today + today's calendar
        // events), fired once when the app is open at/after 6am. The 6am email
        // (morningAgendaAlert Cloud Function) covers the app-closed case.
        const todaysAgenda = [
          ...projDocs.filter(p => !p.archived && !p.declined && p.status !== 'closed'
              && typeof p.startDate === 'string' && (p.startDate as string).slice(0, 10) === todayStr)
            .map(p => `🔨 ${p.jobTypeName || 'Job'} for ${p.customerName || 'customer'}`),
          ...calEvents.docs.map(d => d.data() as { date?: string; title?: string; time?: string; kind?: string })
            .filter(e => e.date === todayStr)
            .map(e => `${e.kind === 'reminder' ? '🔔' : '📌'} ${e.title || 'Event'}${e.time ? ` at ${e.time}` : ''}`),
        ]
        fireMorningAgenda(todaysAgenda)

        setCounts({
          activeJobs, pendingEstimates, customers: customers.size,
          revenueThisMonth, revenueThisWeek, weeklyRevenue, estimatesWon: won.length, estimatesLost: lost, avgJobSize, attention,
        })
      } catch (err) {
        console.error('Dashboard counts failed:', err)
      }
    })()
  }, [userId, refreshKey])
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
  { key: 'schedule', label: 'Schedule', icon: '📅', blurb: 'Upcoming jobs by start date' },
  { key: 'settings', label: 'Settings', icon: '⚙️', blurb: 'Business profile' },
]

const TITLE_MAP: Record<string, string> = {
  dashboard: 'Dashboard',
  estimates: 'Estimates',
  schedule: 'Schedule',
  ...Object.fromEntries(TILES.map(t => [t.key, t.label])),
}

function DashboardHome({ counts, onPick, onBox, onPhotos, onQuickAdd, userName }: { counts: ReturnType<typeof useDashboardCounts>; onPick: (key: string) => void; onBox: (key: string, filter: ProjectStatus | 'all') => void; onPhotos: () => void; onQuickAdd: () => void; userName?: string }) {
  const isMobile = useIsMobile()
  // Browser-notification permission, tracked as state so the UI updates the
  // moment the user responds to the prompt (granted → hide button + show "on";
  // denied → show "blocked"; dismissed → keep the button so they can retry).
  const [notifyBusy, setNotifyBusy] = useState(false)
  // The user's ON/OFF switch for alert sound/vibration/pop-ups (separate from
  // browser permission — they can keep permission but silence alerts).
  const [alertsOn, setAlertsOn] = useState(alertsEnabled())
  // Collapse/expand for the whole reminders table. Persisted so it stays the
  // way the user left it.
  const [tableCollapsed, setTableCollapsed] = useState(() => {
    try { return localStorage.getItem('bp_reminders_collapsed') === 'true' } catch { return false }
  })
  const toggleTableCollapsed = () => {
    setTableCollapsed(c => { const next = !c; try { localStorage.setItem('bp_reminders_collapsed', next ? 'true' : 'false') } catch { /* ignore */ } return next })
  }
  const toggleAlerts = () => {
    const next = !alertsOn
    setAlertsOn(next)
    setAlertsEnabled(next)
    if (next) playAlertCue()   // confirming chirp so they hear it's on
  }
  // Reminders the user has tapped/cleared. Persisted per-DAY in localStorage so
  // a cleared item stays gone for the rest of today, then naturally returns
  // tomorrow if it's still relevant ("clears itself, pops back when necessary").
  const dismissKey = `bp_dismissed_reminders_${new Date().toISOString().slice(0, 10)}`
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(dismissKey) || '[]') as string[]) } catch { return new Set() }
  })
  const dismissReminder = (id: string) => {
    setDismissed(prev => {
      const next = new Set(prev); next.add(id)
      try { localStorage.setItem(dismissKey, JSON.stringify([...next])) } catch { /* ignore quota */ }
      return next
    })
  }

  // Turn alerts ON. The sound + vibration work WITHOUT browser permission, so we
  // enable them immediately. We ALSO quietly try to get pop-up permission as a
  // bonus — but never block on it or show a scolding loop if the browser ignores
  // the request (common on phones / iOS Safari).
  const enableReminders = async () => {
    setNotifyBusy(true)
    try {
      setAlertsEnabled(true); setAlertsOn(true)
      playAlertCue()   // immediate confirming ping so the user knows it worked
      // Best-effort pop-up permission (won't loop / won't scold).
      try { await requestNotificationPermission() } catch { /* ignore */ }
    } finally {
      setNotifyBusy(false)
    }
  }

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const todaysTip = tipOfTheDay()  // rotates daily at 2 AM Eastern
  const counterRow: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(3, 1fr)',
    gap: isMobile ? '12px' : '20px',
    marginBottom: isMobile ? '28px' : '40px',
  }
  const counterCard: React.CSSProperties = {
    // Subtle top-down sheen on a near-white card — keeps it from reading flat.
    background: 'linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%)',
    padding: isMobile ? '16px 12px' : '24px',
    borderRadius: '14px',
    border: '1px solid #eef1f5',
    // Layered shadow: a tight contact shadow + a soft wide ambient one = depth.
    boxShadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)',
    textAlign: 'center',
    transition: 'transform 0.25s cubic-bezier(0.22,1,0.36,1), box-shadow 0.25s cubic-bezier(0.22,1,0.36,1), border-color 0.2s',
  }
  const counterValue: React.CSSProperties = { fontSize: isMobile ? '24px' : '32px', fontWeight: 700, color: ORANGE, lineHeight: 1.1 }
  const counterLabel: React.CSSProperties = { color: '#64748b', fontSize: isMobile ? '11px' : '13px', marginTop: '4px' }

  return (
    <div style={{ padding: isMobile ? '20px' : '40px', maxWidth: '1100px', margin: '0 auto' }}>
      <div className="bp-rise" style={{ marginBottom: isMobile ? '26px' : '36px', animationDelay: '0.02s' }}>
        <h1 style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 800, margin: '0 0 4px', color: NAVY, letterSpacing: '-0.5px' }}>
          {greeting}{userName ? `, ${userName}` : ''}.
        </h1>
        <p style={{ margin: 0, color: '#64748b', fontSize: isMobile ? '14px' : '15px' }}>Here's where things stand today.</p>
      </div>

      {/* Quick actions — Quick Add (voice) + Schedule, as two slim secondary
          bars. Kept visually QUIET (no heavy gradients) so the orange Quick
          Quote hero further down stays the single primary anchor on the page. */}
      <div className="bp-rise" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? '12px' : '16px', marginBottom: isMobile ? '28px' : '36px', animationDelay: '0.09s' }}>
        {/* Voice Quick-Add — tap, talk, and it lands on the calendar. */}
        <button
          onClick={onQuickAdd}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '12px', background: 'white', color: NAVY,
            border: '1px solid #e8ecf1', borderRadius: '12px', padding: isMobile ? '14px 16px' : '16px 18px',
            cursor: 'pointer', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)',
            transition: 'transform 0.1s, border-color 0.1s',
          }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = '#e8ecf1'; e.currentTarget.style.transform = 'translateY(0)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left' }}>
            <span style={{ fontSize: isMobile ? '24px' : '28px' }}>🎙️</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: isMobile ? '15px' : '16px', color: NAVY }}>Quick Add — just say it</div>
              <div style={{ fontSize: isMobile ? '12px' : '13px', color: '#64748b' }}>Tap & talk to add a job, event, or reminder</div>
            </div>
          </div>
          <span style={{ color: ORANGE, fontWeight: 800, fontSize: '18px' }}>›</span>
        </button>

        {/* Quick-access schedule box — fast way to open the Schedule view. */}
        <button
          onClick={() => onPick('schedule')}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '12px', background: 'white', color: NAVY,
            border: '1px solid #e8ecf1', borderRadius: '12px', padding: isMobile ? '14px 16px' : '16px 18px',
            cursor: 'pointer', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)',
            transition: 'transform 0.1s, border-color 0.1s',
          }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = '#e8ecf1'; e.currentTarget.style.transform = 'translateY(0)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left' }}>
            <span style={{ fontSize: isMobile ? '24px' : '28px' }}>📅</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: isMobile ? '15px' : '16px', color: NAVY }}>Schedule</div>
              <div style={{ fontSize: isMobile ? '12px' : '13px', color: '#64748b' }}>See & set your upcoming job dates</div>
            </div>
          </div>
          <span style={{ color: ORANGE, fontWeight: 800, fontSize: '18px' }}>›</span>
        </button>
      </div>

      <div className="bp-rise" style={{ ...counterRow, animationDelay: '0.16s' }}>
        <button
          onClick={() => onBox('projects', 'in_progress')}
          style={{ ...counterCard, cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 18px 40px -10px rgba(249,115,22,0.28)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = '#eef1f5'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)' }}
          title="View active jobs"
        >
          <div style={counterValue}>{counts.activeJobs}</div>
          <div style={counterLabel}>Active Jobs ›</div>
        </button>
        <button
          onClick={() => onPick('estimates')}
          style={{ ...counterCard, cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 18px 40px -10px rgba(249,115,22,0.28)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = '#eef1f5'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)' }}
          title="View pending estimates"
        >
          <div style={counterValue}>{counts.pendingEstimates}</div>
          <div style={counterLabel}>Pending Estimates ›</div>
        </button>
        <button
          onClick={() => onPick('customers')}
          style={{ ...counterCard, cursor: 'pointer' }}
          onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 18px 40px -10px rgba(249,115,22,0.28)' }}
          onMouseOut={e => { e.currentTarget.style.borderColor = '#eef1f5'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)' }}
          title="View customers"
        >
          <div style={counterValue}>{counts.customers}</div>
          <div style={counterLabel}>Customers ›</div>
        </button>
      </div>

      {/* Needs attention — a unified reminder feed so nothing slips through.
          Shown whenever there are to-dos, OR (when empty) as a one-time prompt
          to turn on browser reminders. Tapped items are filtered out for the day. */}
      {(() => {
      const visibleAttention = counts.attention.filter(a => !dismissed.has(a.id))
      return (visibleAttention.length > 0 || !alertsOn) && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '12px', padding: isMobile ? '16px' : '20px', marginBottom: isMobile ? '28px' : '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: tableCollapsed ? 0 : '10px', flexWrap: 'wrap' }}>
            <button onClick={toggleTableCollapsed} title={tableCollapsed ? 'Show reminders' : 'Hide reminders'} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: '#92400e', fontSize: '12px', transform: tableCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▾</span>
              <h2 style={{ fontSize: isMobile ? '14px' : '15px', fontWeight: 800, margin: 0, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🔔 Reminders &amp; to-dos{visibleAttention.length > 0 ? ` (${visibleAttention.length})` : ''}</h2>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {/* A single, ALWAYS-available ON/OFF toggle. Alerts (sound+vibration)
                  don't need browser permission, so the user can always turn them
                  on or off here. First tap also quietly asks for pop-up permission. */}
              {!alertsOn ? (
                <button
                  onClick={enableReminders}
                  disabled={notifyBusy}
                  style={{ background: notifyBusy ? '#cbd5e1' : '#92400e', color: 'white', border: 'none', borderRadius: '8px', padding: '6px 12px', cursor: notifyBusy ? 'default' : 'pointer', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap' }}
                >{notifyBusy ? '…' : '🔕 Alerts OFF — tap to turn on'}</button>
              ) : (
                <button
                  onClick={toggleAlerts}
                  title="Alerts on — sound & vibration. Tap to turn OFF."
                  style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap' }}
                >🔔 Alerts ON — tap to turn off</button>
              )}
            </div>
          </div>

          {/* Collapsible body */}
          {!tableCollapsed && (
            visibleAttention.length === 0 ? (
              <p style={{ margin: 0, fontSize: '13px', color: '#92400e' }}>You're all caught up — nothing needs attention right now. Turn on reminders and we'll alert you about upcoming jobs, overdue payments, and anything else while the app is open.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {visibleAttention.map(a => (
                  // Tap → go to where it's about AND clear it from the list. It
                  // stays cleared for the day, then returns tomorrow if still due.
                  <button key={a.id} onClick={() => { dismissReminder(a.id); onPick(a.goto || 'projects') }} style={{ textAlign: 'left', background: 'white', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 12px', cursor: 'pointer', fontSize: '13px', color: '#1a1f2e', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{ATTENTION_ICON[a.kind] || '•'}</span>
                    <span style={{ flex: 1 }}>{a.label}</span>
                    <span style={{ color: '#94a3b8' }}>›</span>
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      )})()}

      {/* Business stats — the scoreboard. "Paid this week" sits next to "Paid this
          month" so the contractor can see if the money's actually coming in. */}
      {(counts.revenueThisMonth > 0 || counts.revenueThisWeek > 0 || counts.estimatesWon > 0 || counts.estimatesLost > 0) && (
        <div style={{ marginBottom: isMobile ? '20px' : '28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '8px' : '16px', marginBottom: isMobile ? '8px' : '16px' }}>
            <div style={{ ...counterCard, textAlign: 'left' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paid this week</div>
              <div style={{ fontSize: isMobile ? '20px' : '26px', fontWeight: 800, color: '#16a34a' }}>${counts.revenueThisWeek.toLocaleString()}</div>
            </div>
            <div style={{ ...counterCard, textAlign: 'left' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paid this month</div>
              <div style={{ fontSize: isMobile ? '20px' : '26px', fontWeight: 800, color: '#16a34a' }}>${counts.revenueThisMonth.toLocaleString()}</div>
            </div>
            <div style={{ ...counterCard, textAlign: 'left' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Jobs won</div>
              <div style={{ fontSize: isMobile ? '20px' : '26px', fontWeight: 800, color: '#1a1f2e' }}>{counts.estimatesWon}<span style={{ fontSize: '13px', color: '#94a3b8', fontWeight: 600 }}> won · {counts.estimatesLost} lost</span></div>
            </div>
            <div style={{ ...counterCard, textAlign: 'left' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Avg job size</div>
              <div style={{ fontSize: isMobile ? '20px' : '26px', fontWeight: 800, color: '#1a1f2e' }}>${counts.avgJobSize.toLocaleString()}</div>
            </div>
          </div>

          {/* Last 4 weeks — bar chart, so a slow week jumps right out. */}
          {counts.weeklyRevenue.some(w => w.amount > 0) && (() => {
            const maxW = Math.max(...counts.weeklyRevenue.map(w => w.amount), 1)
            return (
              <div style={{ ...counterCard, textAlign: 'left', padding: isMobile ? '14px' : '18px' }}>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Money in — last 4 weeks</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: isMobile ? '10px' : '18px', height: '120px' }}>
                  {counts.weeklyRevenue.map((w, idx) => {
                    const isThis = idx === counts.weeklyRevenue.length - 1
                    const h = Math.max(4, Math.round((w.amount / maxW) * 92))
                    return (
                      <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        <div style={{ fontSize: isMobile ? '11px' : '12px', fontWeight: 700, color: w.amount > 0 ? '#16a34a' : '#cbd5e1', marginBottom: '4px', whiteSpace: 'nowrap' }}>${w.amount.toLocaleString()}</div>
                        <div title={`$${w.amount.toLocaleString()}`} style={{ width: '100%', maxWidth: '64px', height: `${h}px`, borderRadius: '6px 6px 0 0', background: isThis ? ORANGE : '#86efac', transition: 'height 0.3s' }} />
                        <div style={{ fontSize: isMobile ? '10px' : '12px', color: isThis ? NAVY : '#94a3b8', fontWeight: isThis ? 700 : 500, marginTop: '6px' }}>{w.label}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <h2 style={{ fontSize: isMobile ? '16px' : '18px', fontWeight: 700, marginTop: isMobile ? '32px' : '44px', marginBottom: isMobile ? '16px' : '20px', color: NAVY, textTransform: 'uppercase', letterSpacing: '1px' }}>What do you want to do?</h2>
      {/* Quick Quote is the START of the whole process, so it's a big hero box on
          the LEFT; the other three actions stack in a column to its RIGHT and
          together match the hero's height. On mobile everything stacks. */}
      <div className="bp-rise" style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1.15fr 1fr',
        gap: isMobile ? '12px' : '20px',
        alignItems: 'stretch',
        animationDelay: '0.23s',
      }}>
        {/* LEFT — big Quick Quote hero */}
        <button
          onClick={() => onPick('scan-room')}
          style={{
            // Richer 3-stop gradient + a faint inner top highlight = more depth
            // than a flat 2-color fill.
            background: `linear-gradient(140deg, #fb923c 0%, ${ORANGE} 45%, #ea580c 100%)`,
            border: 'none', borderRadius: '20px',
            padding: isMobile ? '24px 20px' : '36px 32px',
            cursor: 'pointer', textAlign: 'left', color: 'white',
            boxShadow: '0 10px 30px -6px rgba(249,115,22,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
            transition: 'transform 0.3s cubic-bezier(0.22,1,0.36,1), box-shadow 0.3s cubic-bezier(0.22,1,0.36,1)',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            gap: isMobile ? '8px' : '12px',
            minHeight: isMobile ? '160px' : '300px',
          }}
          onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 22px 50px -8px rgba(249,115,22,0.55), inset 0 1px 0 rgba(255,255,255,0.3)' }}
          onMouseOut={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 10px 30px -6px rgba(249,115,22,0.45), inset 0 1px 0 rgba(255,255,255,0.25)' }}
        >
          <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.22)', borderRadius: '999px', padding: '4px 12px', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', alignSelf: 'flex-start' }}>Start here</span>
          <div style={{ fontSize: isMobile ? '48px' : '64px', lineHeight: 1 }}>⚡</div>
          <div style={{ fontWeight: 800, fontSize: isMobile ? '26px' : '34px', letterSpacing: '-0.5px' }}>Quick Quote</div>
          <div style={{ fontSize: isMobile ? '14px' : '16px', color: 'rgba(255,255,255,0.9)', lineHeight: 1.4, maxWidth: '320px' }}>
            Snap photos, talk through the job, and get a full priced estimate in seconds. This is where every job begins.
          </div>
          <span style={{ marginTop: '6px', display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'white', color: ORANGE, borderRadius: '10px', padding: isMobile ? '10px 16px' : '12px 20px', fontWeight: 800, fontSize: isMobile ? '14px' : '15px', alignSelf: 'flex-start' }}>
            Start a quote →
          </span>
        </button>

        {/* RIGHT — the other three actions, stacked, sharing the hero's height */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? '12px' : '20px' }}>
          {[
            { key: 'projects', label: 'Projects', icon: '🗂️', blurb: 'Quotes, change orders, photos — all in one place' },
            { key: 'customers', label: 'Customers', icon: '👥', blurb: 'Profiles, photos, history' },
            { key: 'photo-capture', label: 'Job Photos', icon: '📸', blurb: 'Snap photos on site — saved to the job & thank-you letter' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => t.key === 'photo-capture' ? onPhotos() : onPick(t.key)}
              style={{
                flex: isMobile ? 'none' : 1,
                background: 'linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%)',
                border: '1px solid #eef1f5',
                borderRadius: '16px',
                padding: isMobile ? '16px 14px' : '18px 20px',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)',
                transition: 'transform 0.25s cubic-bezier(0.22,1,0.36,1), box-shadow 0.25s cubic-bezier(0.22,1,0.36,1), border-color 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                minHeight: isMobile ? '0' : '0',
              }}
              onMouseOver={e => { e.currentTarget.style.borderColor = ORANGE; e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 18px 40px -10px rgba(249,115,22,0.25)' }}
              onMouseOut={e => { e.currentTarget.style.borderColor = '#eef1f5'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.05), 0 10px 30px -8px rgba(15,23,42,0.10)' }}
            >
              <div style={{ fontSize: isMobile ? '30px' : '36px', lineHeight: 1, flex: '0 0 auto' }}>{t.icon}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: isMobile ? '15px' : '17px', color: NAVY }}>{t.label}</div>
                <div style={{ fontSize: isMobile ? '12px' : '13px', color: '#64748b', lineHeight: 1.3 }}>{t.blurb}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Tip of the Day — ambient, lowest-priority content, so it sits at the
          BOTTOM with a calm light treatment (was a heavy dark bar up top). A
          fresh piece of contractor wisdom each day; renews at 2 AM Eastern. */}
      <div style={{
        background: '#fff7ed', color: NAVY,
        border: '1px solid #fed7aa',
        borderRadius: '14px', padding: isMobile ? '16px 18px' : '18px 22px',
        marginTop: isMobile ? '28px' : '40px', display: 'flex', gap: '14px', alignItems: 'flex-start',
        borderLeft: `4px solid ${ORANGE}`,
      }}>
        <span style={{ fontSize: isMobile ? '22px' : '26px', lineHeight: 1, flex: '0 0 auto' }}>💡</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#ea580c', marginBottom: '4px' }}>
            Tip of the Day · {todaysTip.tag}
          </div>
          <p style={{ margin: 0, fontSize: isMobile ? '14px' : '15px', lineHeight: 1.5, color: '#7c2d12' }}>{todaysTip.tip}</p>
        </div>
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
  // Bumped by the live listeners below so the count tiles + reminders feed
  // recompute whenever the underlying data changes (no page reload needed).
  const [countsRefresh, setCountsRefresh] = useState(0)
  const counts = useDashboardCounts(user?.id, countsRefresh)
  const isMobile = useIsMobile()
  const [conversionToast, setConversionToast] = useState<string | null>(null)
  const [photoCaptureOpen, setPhotoCaptureOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
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
      () => { runSweep(); setCountsRefresh(k => k + 1) },
      err => console.error('Estimate listener failed:', err),
    )

    return () => { cancelled = true; unsub() }
  }, [user?.id])

  // Keep the dashboard count tiles + reminders feed live: any change to the
  // contractor's projects, invoices, change orders, or calendar events bumps a
  // refresh key that re-runs useDashboardCounts. (Estimates are covered by the
  // sweep listener above.)
  useEffect(() => {
    if (!user?.id) return
    const bump = () => setCountsRefresh(k => k + 1)
    const unsubs = [
      onSnapshot(query(collection(db, 'projects'), where('createdBy', '==', user.id)), bump, err => console.error('Projects count listener failed:', err)),
      onSnapshot(query(collection(db, 'invoices'), where('createdBy', '==', user.id)), bump, err => console.error('Invoices count listener failed:', err)),
      onSnapshot(query(collection(db, 'changeOrders'), where('createdBy', '==', user.id)), bump, err => console.error('ChangeOrders count listener failed:', err)),
      onSnapshot(query(collection(db, 'calendarEvents'), where('createdBy', '==', user.id)), bump, err => console.error('Calendar count listener failed:', err)),
    ]
    return () => unsubs.forEach(u => u())
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

  // Let deep child components (e.g. the Pro-locked thank-you card in Projects)
  // jump to Settings/billing via a simple document event, without threading a
  // nav callback through every layer.
  useEffect(() => {
    const handler = () => { setPage('settings'); setMenuOpen(false) }
    document.addEventListener('bp-go-settings', handler)
    return () => document.removeEventListener('bp-go-settings', handler)
  }, [])

  const navItem = (label: string, icon: string, key: string) => (
    <a key={key} onClick={() => go(key)} style={{
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
        {quickAddOpen && <QuickAddVoice onClose={() => setQuickAddOpen(false)} />}

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
              boxShadow: '0 24px 60px rgba(15,23,42,0.18)',
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
            <DashboardHome counts={counts} onPick={go} onBox={goWithFilter} onPhotos={() => setPhotoCaptureOpen(true)} onQuickAdd={() => setQuickAddOpen(true)} userName={user?.firstName || undefined} />
          </>
        )}
        {page === 'projects' && <Projects key={projectsFilter} initialStatusFilter={projectsFilter} />}
        {page === 'estimates' && <Estimates />}
        {page === 'schedule' && <Schedule onOpenProject={() => go('projects')} />}
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

// Public legal pages — /terms and /privacy (no sign-in).
function legalPageFromUrl(): 'terms' | 'privacy' | null {
  if (typeof window === 'undefined') return null
  const p = window.location.pathname.replace(/\/$/, '')
  if (p === '/terms') return 'terms'
  if (p === '/privacy') return 'privacy'
  return null
}

// Match /inv/<id> — public invoice viewer.
function publicInvoiceIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.pathname.match(/^\/inv\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

function App() {
  // Welcome tour for brand-new visitors who tap "Sign Up". Declared before the
  // early returns below so the hook order stays stable (Rules of Hooks).
  const [tourOpen, setTourOpen] = useState(false)
  // Drives the signed-out landing layout (asymmetric 2-col on desktop, single
  // column on mobile). Must run before the early returns below (Rules of Hooks).
  const isMobile = useIsMobile()

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

  const legal = legalPageFromUrl()
  if (legal === 'terms') return <TermsPage />
  if (legal === 'privacy') return <PrivacyPage />

  return (
    <div>
      <SignedOut>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: `linear-gradient(135deg, ${NAVY} 0%, #0f172a 100%)`, padding: '24px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1.05fr 0.95fr',
            gap: isMobile ? '32px' : '56px',
            alignItems: 'center',
            maxWidth: '960px',
            width: '100%',
            color: 'white',
          }}>
            {/* LEFT — brand eyebrow, benefit headline, value prop, CTAs, legal */}
            <div style={{ textAlign: isMobile ? 'center' : 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: isMobile ? 'center' : 'flex-start', marginBottom: '24px' }}>
                <div style={{ width: '44px', height: '44px', background: ORANGE, borderRadius: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 800, color: 'white', boxShadow: '0 8px 24px rgba(249,115,22,0.4)' }}>B</div>
                <span style={{ color: ORANGE, fontSize: '13px', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 700 }}>BuildPro+ · Contractor Suite</span>
              </div>

              <h1 style={{ fontSize: isMobile ? '34px' : '46px', margin: '0 0 16px', lineHeight: 1.08, fontWeight: 800, letterSpacing: '-1px' }}>
                Quote the job before<br />you leave the driveway.
              </h1>

              <p style={{ margin: '0 0 32px', color: '#cbd5e1', fontSize: '17px', lineHeight: 1.55, maxWidth: '440px', marginLeft: isMobile ? 'auto' : 0, marginRight: isMobile ? 'auto' : 0 }}>
                Instant quotes, customer e-sign, change orders, and photo project tracking — built for working contractors.
              </p>

              {/* New here? "See how it works" walks through a quick tour first, then
                  creates the account. Already have a login? Sign In goes straight in. */}
              <div style={{ display: 'flex', gap: '12px', justifyContent: isMobile ? 'center' : 'flex-start', flexWrap: 'wrap' }}>
                <button onClick={() => setTourOpen(true)} style={{ background: ORANGE, color: 'white', border: 'none', padding: '16px 32px', borderRadius: '10px', fontSize: '16px', cursor: 'pointer', fontWeight: 700, boxShadow: '0 6px 18px rgba(249,115,22,0.35)' }}>
                  See how it works →
                </button>
                <SignInButton mode="modal">
                  <button style={{ background: 'transparent', color: '#e2e8f0', border: '1.5px solid rgba(255,255,255,0.25)', padding: '16px 28px', borderRadius: '10px', fontSize: '16px', cursor: 'pointer', fontWeight: 600 }}>
                    Sign In
                  </button>
                </SignInButton>
              </div>

              {/* Agreement notice — by signing up/in, users accept the Terms &
                  Privacy Policy. This is what creates the binding agreement. */}
              <p style={{ marginTop: '40px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5, maxWidth: '420px', marginLeft: isMobile ? 'auto' : 0, marginRight: isMobile ? 'auto' : 0 }}>
                By creating an account or signing in, you agree to our{' '}
                <a href="/terms" style={{ color: ORANGE, textDecoration: 'underline' }}>Terms of Service</a>{' '}and{' '}
                <a href="/privacy" style={{ color: ORANGE, textDecoration: 'underline' }}>Privacy Policy</a>.
              </p>
            </div>

            {/* RIGHT — value-prop card. Balances the copy column (asymmetric
                balance) and gives the eye a clear figure to land on. */}
            <div style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '20px',
              padding: '28px',
              boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
              backdropFilter: 'blur(4px)',
            }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'rgba(249,115,22,0.15)', color: ORANGE, borderRadius: '999px', padding: '6px 14px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                ⚡ Quick Quote
              </div>
              <p style={{ margin: '16px 0 20px', fontSize: '18px', lineHeight: 1.4, fontWeight: 700, color: 'white' }}>
                Snap photos, talk through the job, and get a full priced estimate in seconds.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {[
                  { icon: '✍️', text: 'Customer e-sign on every estimate' },
                  { icon: '🔄', text: 'Change orders that update the contract total' },
                  { icon: '📸', text: 'Photo logs sent with the thank-you' },
                ].map(f => (
                  <div key={f.text} style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#e2e8f0', fontSize: '14px' }}>
                    <span style={{ fontSize: '18px', flex: '0 0 auto' }}>{f.icon}</span>
                    <span>{f.text}</span>
                  </div>
                ))}
              </div>
              <p style={{ margin: '24px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 }}>
                📱 Add to your home screen for one-tap access — Safari Share → Add to Home Screen, or Chrome menu → Install app.
              </p>
            </div>
          </div>
        </div>
        {tourOpen && <WelcomeTour onClose={() => setTourOpen(false)} />}
      </SignedOut>
      <SignedIn>
        <FirebaseGate />
      </SignedIn>
    </div>
  )
}

export default App
