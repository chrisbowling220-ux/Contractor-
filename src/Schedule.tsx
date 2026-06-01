import { useEffect, useMemo, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import type { Project } from './data/types'
import { PROJECT_STATUS_LABEL } from './data/types'

const ORANGE = '#f97316'

// Schedule view — upcoming jobs grouped by start date so the contractor can see
// what's happening when. Pulls projects that have a startDate set and aren't
// archived/declined. "Starts tomorrow" is highlighted (the day-before reminder
// will key off this once notifications are wired up post-domain).
export default function Schedule({ onOpenProject }: { onOpenProject?: (projectId: string) => void }) {
  const { user } = useUser()
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(
      query(collection(db, 'projects'), where('createdBy', '==', user.id)),
      snap => setProjects(snap.docs.map(d => ({ id: d.id, ...d.data() } as Project))),
      err => console.error('Schedule listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  const scheduled = useMemo(() => {
    return projects
      .filter(p => p.startDate && !p.archived && !p.declined && p.status !== 'closed')
      .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
  }, [projects])

  // Group by date.
  const groups = useMemo(() => {
    const m = new Map<string, Project[]>()
    for (const p of scheduled) {
      const d = (p.startDate || '').slice(0, 10)
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(p)
    }
    return Array.from(m.entries())
  }, [scheduled])

  const todayStr = new Date().toISOString().slice(0, 10)
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const dayLabel = (d: string) => {
    const date = new Date(d + 'T12:00:00')
    const base = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    if (d === todayStr) return `Today · ${base}`
    if (d === tomorrowStr) return `Tomorrow · ${base}`
    return base
  }
  const isPast = (d: string) => d < todayStr

  const card: React.CSSProperties = { background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: '14px 16px', marginBottom: '10px', cursor: 'pointer', border: '2px solid transparent' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '900px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '24px', fontWeight: 800, margin: '0 0 4px', color: '#1a1f2e' }}>📅 Schedule</h2>
      <p style={{ margin: '0 0 20px', color: '#64748b', fontSize: '14px' }}>Your upcoming jobs by start date. Set a start date on any project to see it here.</p>

      {groups.length === 0 ? (
        <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: '40px 16px', textAlign: 'center', color: '#94a3b8' }}>
          No jobs scheduled yet. Open a project and set its <strong>Scheduled Start</strong> date — it'll show up here.
        </div>
      ) : (
        groups.map(([date, items]) => (
          <div key={date} style={{ marginBottom: '24px' }}>
            <h3 style={{
              fontSize: '14px', fontWeight: 800, margin: '0 0 10px',
              color: date === tomorrowStr ? ORANGE : isPast(date) ? '#94a3b8' : '#1a1f2e',
              textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>
              {dayLabel(date)} {date === tomorrowStr && '🔔'}
            </h3>
            {items.map(p => (
              <div
                key={p.id}
                onClick={() => onOpenProject?.(p.id)}
                style={card}
                onMouseOver={e => (e.currentTarget.style.borderColor = ORANGE)}
                onMouseOut={e => (e.currentTarget.style.borderColor = 'transparent')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: '15px' }}>{p.customerName}</p>
                    <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#64748b' }}>{p.jobTypeName}{p.jobLocationZip ? ` · ZIP ${p.jobLocationZip}` : ''}</p>
                  </div>
                  <span style={{ background: '#fff7ed', color: '#ea580c', padding: '4px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' }}>{PROJECT_STATUS_LABEL[p.status]}</span>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
