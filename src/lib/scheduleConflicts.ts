// Double-booking check for the schedule. Pure, so it is unit-tested.
//
// Deliberately narrow, because a contractor's day normally holds several
// things: it only speaks up when two entries share the same clock time, or
// when a new JOB lands on a day that already has a job (a calendar job or a
// project starting that day).

interface EventLike { id: string; title: string; time?: string; kind?: 'job' | 'event' | 'reminder' }
interface ProjectLike { id: string; customerName?: string; jobTypeName?: string }

export function scheduleConflicts(
  entry: { time?: string; kind?: 'job' | 'event' | 'reminder'; editingId?: string | null },
  sameDay: { events?: EventLike[]; projects?: ProjectLike[] },
): string[] {
  const others = (sameDay.events || []).filter(e => e.id !== entry.editingId)
  const out: string[] = []
  if (entry.time) {
    for (const e of others) {
      if (e.time && e.time === entry.time && e.kind !== 'reminder') out.push(`"${e.title}" is also at ${formatTime(e.time)}`)
    }
  }
  if (entry.kind === 'job') {
    for (const e of others) {
      const line = `"${e.title}" is also at ${formatTime(e.time || '')}`
      if (e.kind === 'job' && !out.includes(line)) out.push(`Job "${e.title}" is already on this day`)
    }
    for (const p of sameDay.projects || []) {
      out.push(`${p.customerName || 'A project'}${p.jobTypeName ? ` (${p.jobTypeName})` : ''} starts this day`)
    }
  }
  return out
}

// "14:30" → "2:30 PM"
export function formatTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}
