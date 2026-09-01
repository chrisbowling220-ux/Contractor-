import type { Project, CalendarEvent } from '../data/types'

// Turns a day on the calendar into something worth hearing out loud.
//
// Written for a phone on a truck dashboard, not a screen reader: short
// sentences, times spoken the way a person says them ("nine AM", not "09:00"),
// and the count up front so the contractor knows how bad the day is before the
// list starts. Kept under the function's 1200-character cap by trimming the
// tail rather than letting the server cut it mid-sentence.

const MAX_SPOKEN_ITEMS = 10

// "09:00" → "9 AM", "14:30" → "2:30 PM". Anything unparseable is dropped
// rather than read out as digits.
function spokenTime(hhmm?: string): string {
  if (!hhmm) return ''
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return ''
  const hour24 = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hour24) || hour24 > 23 || minutes > 59) return ''
  const suffix = hour24 < 12 ? 'AM' : 'PM'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return minutes === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

function spokenDate(dateISO: string): string {
  const d = new Date(dateISO + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return 'today'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

// Strip anything that reads badly aloud — emoji, bullets, repeated whitespace.
function sayable(text: string): string {
  return (text || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface DayRundownInput {
  dateISO: string
  projects: Project[]
  events: CalendarEvent[]
  /** Said instead of the date, e.g. "Today". */
  spokenLabel?: string
}

export function buildDayRundown({ dateISO, projects, events, spokenLabel }: DayRundownInput): string {
  const when = spokenLabel || spokenDate(dateISO)

  const jobLines = projects.map(p => {
    const job = sayable(p.jobTypeName)
    const who = sayable(p.customerName) || 'a customer'
    return { sortKey: '', time: '', text: job ? `${job} for ${who}` : `Job for ${who}` }
  })

  const eventLines = events.map(e => {
    const title = sayable(e.title) || 'Untitled'
    const lead = e.kind === 'reminder' ? 'Reminder: ' : ''
    // Sort on the raw 24-hour "HH:MM" — the spoken form ("9 AM" vs "10:30 AM")
    // does not sort correctly as text.
    return { sortKey: e.time || '', time: spokenTime(e.time), text: `${lead}${title}` }
  })

  // Timed items first, in clock order — that's the order the day happens in.
  const all = [...jobLines, ...eventLines].sort((a, b) => {
    if (a.sortKey && b.sortKey) return a.sortKey.localeCompare(b.sortKey)
    if (a.sortKey) return -1
    if (b.sortKey) return 1
    return 0
  })

  if (all.length === 0) return `${when}. Nothing on the books.`

  const shown = all.slice(0, MAX_SPOKEN_ITEMS)
  const overflow = all.length - shown.length

  const count = all.length === 1 ? 'one thing' : `${all.length} things`
  const parts = [`${when}. You've got ${count}.`]

  shown.forEach(item => {
    parts.push(item.time ? `At ${item.time}, ${item.text}.` : `${item.text}.`)
  })

  if (overflow > 0) parts.push(`Plus ${overflow} more on the calendar.`)

  return parts.join(' ')
}
