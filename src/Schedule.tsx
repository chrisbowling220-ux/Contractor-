import { useEffect, useMemo, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore'
import { db } from './firebase'
import type { Project, CalendarEvent } from './data/types'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A real, full calendar: navigate any month/year forever, tap any day to add or
// edit jobs/events, with everything stored per-user. Project start dates show
// automatically alongside the contractor's custom events. Notifications/reminders
// for upcoming and overdue items are surfaced at the top.
export default function Schedule({ onOpenProject }: { onOpenProject?: (projectId: string) => void }) {
  const { user } = useUser()
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [viewYear, setViewYear] = useState(new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(new Date().getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.id) return
    const unsubP = onSnapshot(
      query(collection(db, 'projects'), where('createdBy', '==', user.id)),
      snap => setProjects(snap.docs.map(d => ({ id: d.id, ...d.data() } as Project))),
      err => console.error('Schedule projects listener failed:', err),
    )
    const unsubE = onSnapshot(
      query(collection(db, 'calendarEvents'), where('createdBy', '==', user.id)),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarEvent))),
      err => console.error('Calendar events listener failed:', err),
    )
    return () => { unsubP(); unsubE() }
  }, [user?.id])

  // Map date -> items (project starts + custom events) for quick lookup.
  const itemsByDate = useMemo(() => {
    const m = new Map<string, { projects: Project[]; events: CalendarEvent[] }>()
    const get = (d: string) => { if (!m.has(d)) m.set(d, { projects: [], events: [] }); return m.get(d)! }
    projects.filter(p => p.startDate && !p.archived && !p.declined && p.status !== 'closed')
      .forEach(p => get((p.startDate as string).slice(0, 10)).projects.push(p))
    events.forEach(e => get(e.date).events.push(e))
    return m
  }, [projects, events])

  // Build the grid for the visible month (leading/trailing blanks for alignment).
  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1)
    const startPad = first.getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: ({ day: number; date: string } | null)[] = []
    for (let i = 0; i < startPad; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, date: ymd(new Date(viewYear, viewMonth, d)) })
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [viewYear, viewMonth])

  const todayStr = ymd(new Date())
  const prevMonth = () => { const m = viewMonth - 1; if (m < 0) { setViewMonth(11); setViewYear(y => y - 1) } else setViewMonth(m) }
  const nextMonth = () => { const m = viewMonth + 1; if (m > 11) { setViewMonth(0); setViewYear(y => y + 1) } else setViewMonth(m) }
  const goToday = () => { const n = new Date(); setViewYear(n.getFullYear()); setViewMonth(n.getMonth()) }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 28px)', maxWidth: '1000px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '24px', fontWeight: 800, margin: '0 0 4px', color: NAVY }}>📅 Schedule</h2>
      <p style={{ margin: '0 0 16px', color: '#64748b', fontSize: '14px' }}>Tap any day to add a job, appointment, or reminder. Scheduled jobs show automatically.</p>

      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '8px' }}>
        <button onClick={prevMonth} style={navBtn}>‹</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ fontSize: '18px', fontWeight: 800, color: NAVY }}>{MONTHS[viewMonth]} {viewYear}</span>
          <button onClick={goToday} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: NAVY }}>Today</button>
        </div>
        <button onClick={nextMonth} style={navBtn}>›</button>
      </div>

      {/* Day-of-week header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
        {DOW.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', padding: '4px 0' }}>{d}</div>)}
      </div>

      {/* The month grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {grid.map((cell, i) => {
          if (!cell) return <div key={i} style={{ minHeight: '70px' }} />
          const items = itemsByDate.get(cell.date)
          const count = (items?.projects.length || 0) + (items?.events.length || 0)
          const isToday = cell.date === todayStr
          return (
            <button
              key={i}
              onClick={() => setSelectedDate(cell.date)}
              style={{
                minHeight: '70px', background: 'white', border: isToday ? `2px solid ${ORANGE}` : '1px solid #e2e8f0',
                borderRadius: '8px', padding: '6px', cursor: 'pointer', textAlign: 'left',
                display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden',
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: isToday ? 800 : 600, color: isToday ? ORANGE : NAVY }}>{cell.day}</span>
              {items?.projects.slice(0, 2).map(p => (
                <span key={p.id} style={{ fontSize: '10px', background: '#fff7ed', color: '#ea580c', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🔨 {p.customerName}</span>
              ))}
              {items?.events.slice(0, 2).map(e => (
                <span key={e.id} style={{ fontSize: '10px', background: '#eff6ff', color: '#1e40af', borderRadius: '4px', padding: '1px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.kind === 'reminder' ? '🔔' : '📌'} {e.title}</span>
              ))}
              {count > 4 && <span style={{ fontSize: '9px', color: '#94a3b8' }}>+{count - 4} more</span>}
            </button>
          )
        })}
      </div>

      {selectedDate && (
        <DayModal
          date={selectedDate}
          items={itemsByDate.get(selectedDate)}
          userId={user?.id}
          onClose={() => setSelectedDate(null)}
          onOpenProject={onOpenProject}
        />
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = { background: NAVY, color: 'white', border: 'none', borderRadius: '8px', width: '40px', height: '40px', cursor: 'pointer', fontSize: '22px', fontWeight: 700, lineHeight: 1 }

// Day detail modal — see what's on this day, add/edit/delete custom events.
function DayModal({ date, items, userId, onClose, onOpenProject }: {
  date: string
  items?: { projects: Project[]; events: CalendarEvent[] }
  userId?: string
  onClose: () => void
  onOpenProject?: (projectId: string) => void
}) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [time, setTime] = useState('')
  const [kind, setKind] = useState<'job' | 'event' | 'reminder'>('event')
  const [remind, setRemind] = useState('1') // days before; '' = none
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const pretty = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const reset = () => { setTitle(''); setNotes(''); setTime(''); setKind('event'); setRemind('1'); setEditingId(null) }

  const save = async () => {
    if (!userId || !title.trim()) return
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        date, title: title.trim(), kind,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(time ? { time } : {}),
        ...(remind !== '' ? { remindDaysBefore: Number(remind) } : {}),
        createdBy: userId,
      }
      if (editingId) {
        await updateDoc(doc(db, 'calendarEvents', editingId), payload)
      } else {
        await addDoc(collection(db, 'calendarEvents'), { ...payload, createdAt: new Date().toISOString() })
      }
      reset()
    } catch (err) {
      alert('Could not save: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (e: CalendarEvent) => {
    setEditingId(e.id); setTitle(e.title); setNotes(e.notes || ''); setTime(e.time || '')
    setKind(e.kind || 'event'); setRemind(e.remindDaysBefore != null ? String(e.remindDaysBefore) : '')
  }
  const remove = async (e: CalendarEvent) => {
    if (!confirm(`Delete "${e.title}"?`)) return
    try { await deleteDoc(doc(db, 'calendarEvents', e.id)) } catch (err) { alert('Delete failed: ' + (err instanceof Error ? err.message : String(err))) }
  }

  const input: React.CSSProperties = { width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: NAVY, color: 'white', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
          <button onClick={onClose} style={{ background: ORANGE, color: 'white', border: 'none', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>← Back</button>
          <h2 style={{ margin: 0, color: ORANGE, fontSize: '17px' }}>{pretty}</h2>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Scheduled jobs (from projects) */}
          {items?.projects && items.projects.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{ ...label, marginBottom: '6px' }}>🔨 Jobs scheduled today</p>
              {items.projects.map(p => (
                <button key={p.id} onClick={() => { onOpenProject?.(p.id); onClose() }} style={{ display: 'block', width: '100%', textAlign: 'left', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '10px 12px', marginBottom: '6px', cursor: 'pointer' }}>
                  <span style={{ fontWeight: 700, fontSize: '14px' }}>{p.customerName}</span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}> · {p.jobTypeName} ›</span>
                </button>
              ))}
            </div>
          )}

          {/* Existing custom events */}
          {items?.events && items.events.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{ ...label, marginBottom: '6px' }}>📌 Your entries</p>
              {items.events.sort((a, b) => (a.time || '').localeCompare(b.time || '')).map(e => (
                <div key={e.id} style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>{e.kind === 'reminder' ? '🔔 ' : e.kind === 'job' ? '🔨 ' : '📌 '}{e.title}</span>
                      {e.time && <span style={{ fontSize: '12px', color: '#64748b' }}> · {e.time}</span>}
                      {e.notes && <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#64748b' }}>{e.notes}</p>}
                      {e.remindDaysBefore != null && <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#7c3aed' }}>🔔 Reminder {e.remindDaysBefore === 0 ? 'day-of' : `${e.remindDaysBefore} day(s) before`}</p>}
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button onClick={() => startEdit(e)} style={{ background: '#f1f5f9', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}>✏️</button>
                      <button onClick={() => remove(e)} style={{ background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}>🗑️</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add / edit form */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px' }}>
            <p style={{ ...label, marginBottom: '10px' }}>{editingId ? '✏️ Edit entry' : '➕ Add a job, appointment, or reminder'}</p>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What's happening? (e.g. Start Miller bathroom)" style={{ ...input, marginBottom: '10px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
              <div>
                <label style={label}>Type</label>
                <select value={kind} onChange={e => setKind(e.target.value as 'job' | 'event' | 'reminder')} style={input}>
                  <option value="event">Appointment / Event</option>
                  <option value="job">Job</option>
                  <option value="reminder">Reminder</option>
                </select>
              </div>
              <div>
                <label style={label}>Time (optional)</label>
                <input type="time" value={time} onChange={e => setTime(e.target.value)} style={input} />
              </div>
            </div>
            <div style={{ marginBottom: '10px' }}>
              <label style={label}>Remind me</label>
              <select value={remind} onChange={e => setRemind(e.target.value)} style={input}>
                <option value="">No reminder</option>
                <option value="0">On the day</option>
                <option value="1">1 day before</option>
                <option value="2">2 days before</option>
                <option value="3">3 days before</option>
                <option value="7">1 week before</option>
              </select>
            </div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Notes (optional)" style={{ ...input, fontFamily: 'inherit', resize: 'vertical', marginBottom: '10px' }} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={save} disabled={saving || !title.trim()} style={{ flex: 1, background: saving || !title.trim() ? '#cbd5e1' : '#16a34a', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: saving || !title.trim() ? 'default' : 'pointer', fontWeight: 700, fontSize: '14px' }}>
                {saving ? 'Saving…' : editingId ? 'Update' : 'Add to Calendar'}
              </button>
              {editingId && <button onClick={reset} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
