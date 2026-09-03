import { useEffect, useMemo, useRef, useState } from 'react'
import { useUser, useAuth } from '@clerk/clerk-react'
import { collection, query, where, onSnapshot, addDoc, deleteDoc, doc, getDocs, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { useTier } from './lib/useTier'
import { useVoiceOutput } from './lib/useVoiceOutput'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

// Mirrors ADVISOR_FREE_MESSAGES_PER_MONTH in functions/src/index.ts. The server
// is what enforces it; this copy only shapes what the UI promises.
const FREE_QUESTIONS_PER_MONTH = 5

const askCallable = httpsCallable<
  { clerkToken: string; input: { sessionId: string; message: string } },
  { reply: string; spoken: string; monthlyRemaining: number | null; tier: 'free' | 'pro' }
>(functions, 'askPropertyAdvisor')

// Mirrors the record schema in functions/src/propertyLookup.ts. Numbers are
// nullable because a blank and a zero mean different things; text fields use an
// empty string for "not confirmed", which is what the schema's union budget
// allowed.
export interface PropertyRecord {
  found: boolean
  confidence: 'high' | 'medium' | 'low'
  normalizedAddress: string
  status: 'for_sale' | 'pending' | 'contingent' | 'sold' | 'off_market' | 'for_rent' | 'unknown'
  statusNote: string
  listPrice: number | null
  priceHistoryNote: string
  estimatedValue: number | null
  estimateSource: string
  lastSoldPrice: number | null
  lastSoldDate: string
  beds: number | null
  baths: number | null
  sqft: number | null
  lotSizeAcres: number | null
  yearBuilt: number | null
  propertyType: string
  daysOnMarket: number | null
  hoaMonthly: number | null
  annualTaxes: number | null
  taxAssessedValue: number | null
  parcelId: string
  extraFacts: { label: string; value: string }[]
  highlights: string[]
  watchOuts: string[]
  comps: { address: string; detail: string }[]
  marketNote: string
  unconfirmed: string[]
  sources: { label: string; url: string; asOf: string }[]
  summary: string
  lookedUpAt?: string
}

const lookupCallable = httpsCallable<
  { clerkToken: string; input: { address: string; sessionId?: string } },
  { sessionId: string; record: PropertyRecord; monthlyRemaining: number | null; tier: 'free' | 'pro' }
>(functions, 'lookupProperty')

const transcribeCallable = httpsCallable<
  { clerkToken: string; input: { audioBase64: string; mimeType: string } },
  { transcript: string }
>(functions, 'transcribeAudio')

// A spoken question is a question, not a monologue. Long enough to describe a
// problem out loud, short enough that a phone left recording in a pocket can't
// run up a Speech-to-Text bill.
const VOICE_MAX_SECONDS = 25

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(((r.result as string).split(',')[1]) || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function pickRecorderMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg']
  if (typeof MediaRecorder === 'undefined') return ''
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

type Goal = 'buying' | 'selling' | 'flipping' | 'researching'

interface PropertyContext {
  location?: string | null
  propertyType?: string | null
  yearBuilt?: number | null
  priceContext?: number | null
  userGoal?: Goal
  conditionNotes?: string | null
}

interface AdvisorSession {
  id: string
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  lastMessagePreview?: string
  propertyContext?: PropertyContext
  // Present once an address lookup has run against this property.
  propertyRecord?: PropertyRecord
}

interface AdvisorMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  // The say-it-out-loud version of this answer, written by the advisor at the
  // same time as the long one. Absent on answers from before voice existed —
  // those fall back to reading the top of the written answer.
  spokenContent?: string
  createdAt?: string
}

const GOALS: { key: Goal; label: string; hint: string }[] = [
  { key: 'buying', label: 'Buying', hint: 'Should I move forward on this one?' },
  { key: 'flipping', label: 'Flipping', hint: 'Does the deal actually pencil out?' },
  { key: 'selling', label: 'Selling', hint: 'How do I price and list it?' },
  { key: 'researching', label: 'Just looking', hint: 'Getting a feel for it' },
]

// Shown in order while a lookup runs, ~14s apart. They are the real steps, not
// filler — someone watching should be able to tell where it got to if it fails.
const LOOKUP_STAGES = [
  'Finding the property…',
  'Checking the listing sites…',
  'Pulling county and tax records…',
  'Looking at what sold nearby…',
  'Reading the local market…',
  'Putting it together…',
]

// The three domains, one button each, so the first question is never a blank page.
const QUICK_PROMPTS = [
  { label: 'Is this a good deal?', text: 'Is this a good deal? Walk me through the numbers.' },
  { label: 'What should I worry about?', text: 'What should I worry about structurally on a place like this?' },
  { label: 'How should I price it?', text: 'How should I price and list this to sell fast without leaving money on the table?' },
]

// A property's name in the session list: the address if they gave one, else
// enough of the other details to tell two houses apart.
function sessionTitle(s: AdvisorSession): string {
  const c = s.propertyContext ?? {}
  if (s.propertyRecord?.normalizedAddress) return s.propertyRecord.normalizedAddress
  if (c.location) return c.location
  const parts = [c.propertyType, c.yearBuilt ? `built ${c.yearBuilt}` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Untitled property'
}

function money(n?: number | null): string {
  return typeof n === 'number' && n > 0 ? `$${n.toLocaleString('en-US')}` : ''
}

// Answers come back as plain text with blank-line paragraphs, "- " bullets and
// the occasional "**heading**". Enough structure to read well without pulling
// in a markdown dependency for one screen.
function AnswerText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const isList = lines.every(l => /^[-*•]\s+/.test(l.trim()))
        if (isList) {
          return (
            <ul key={i} style={{ margin: '0 0 10px', paddingLeft: '20px', display: 'grid', gap: '4px' }}>
              {lines.map((l, j) => <li key={j} style={{ fontSize: '14px', lineHeight: 1.55 }}>{inline(l.replace(/^[-*•]\s+/, ''))}</li>)}
            </ul>
          )
        }
        return <p key={i} style={{ margin: '0 0 10px', fontSize: '14px', lineHeight: 1.55 }}>{inline(block)}</p>
      })}
    </>
  )
}

// **bold** → <strong>. Everything else stays literal.
function inline(s: string) {
  const parts = s.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>,
  )
}

// ── The property card ────────────────────────────────────────────────────
// What the lookup found, laid out the way someone reads it standing in the
// driveway: what they're asking, what the house is, then everything else
// folded away until they want it. Two rules the layout enforces —
//
//   1. Asking price, published estimate and last sold price never share a
//      styling. Confusing those three is the expensive mistake.
//   2. What the lookup could NOT confirm gets its own block, as prominent as
//      the facts. A gap the buyer knows about is worth as much as a fact.

const STATUS_STYLE: Record<PropertyRecord['status'], { label: string; bg: string; fg: string }> = {
  for_sale: { label: 'On the market', bg: '#dcfce7', fg: '#166534' },
  pending: { label: 'Pending', bg: '#fef3c7', fg: '#92400e' },
  contingent: { label: 'Under contract', bg: '#fef3c7', fg: '#92400e' },
  sold: { label: 'Sold', bg: '#e2e8f0', fg: '#334155' },
  off_market: { label: 'Not listed', bg: '#e2e8f0', fg: '#334155' },
  for_rent: { label: 'For rent', bg: '#dbeafe', fg: '#1e40af' },
  unknown: { label: 'Status unconfirmed', bg: '#f1f5f9', fg: '#64748b' },
}

function usd(n: number | null | undefined): string {
  return typeof n === 'number' && n > 0 ? `$${Math.round(n).toLocaleString('en-US')}` : ''
}

function Fold({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <details style={{ borderTop: '1px solid #eef2f6', paddingTop: '10px', marginTop: '10px' }}>
      <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 700, color: NAVY, listStyle: 'revert' }}>
        {title}{typeof count === 'number' && count > 0 ? ` (${count})` : ''}
      </summary>
      <div style={{ marginTop: '8px' }}>{children}</div>
    </details>
  )
}

function Bullets({ items, color }: { items: string[]; color: string }) {
  return (
    <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '5px' }}>
      {items.map((t, i) => <li key={i} style={{ fontSize: '13px', lineHeight: 1.5, color }}>{t}</li>)}
    </ul>
  )
}

function PropertyCard({ rec, onRefresh, refreshing }: { rec: PropertyRecord; onRefresh: () => void; refreshing: boolean }) {
  const st = STATUS_STYLE[rec.status] ?? STATUS_STYLE.unknown
  const shape = [
    rec.beds !== null ? `${rec.beds} bed` : '',
    rec.baths !== null ? `${rec.baths} bath` : '',
    rec.sqft !== null ? `${rec.sqft.toLocaleString('en-US')} sq ft` : '',
    rec.lotSizeAcres !== null ? `${rec.lotSizeAcres} ac lot` : '',
    rec.yearBuilt !== null ? `built ${rec.yearBuilt}` : '',
    rec.propertyType,
  ].filter(Boolean).join('  ·  ')
  const perSqft = rec.listPrice && rec.sqft ? Math.round(rec.listPrice / rec.sqft) : null

  // Every money figure that isn't the asking price, kept visually subordinate
  // to it and always labelled with what kind of number it is.
  const moneyRows: { k: string; v: string }[] = [
    { k: 'Published estimate', v: rec.estimatedValue ? `${usd(rec.estimatedValue)}${rec.estimateSource ? ` · ${rec.estimateSource}` : ''}` : '' },
    { k: 'Last sold', v: rec.lastSoldPrice ? `${usd(rec.lastSoldPrice)}${rec.lastSoldDate ? ` · ${rec.lastSoldDate}` : ''}` : '' },
    { k: 'Taxes', v: rec.annualTaxes ? `${usd(rec.annualTaxes)}/yr` : '' },
    { k: 'HOA', v: rec.hoaMonthly ? `${usd(rec.hoaMonthly)}/mo` : '' },
    { k: 'County assessed', v: usd(rec.taxAssessedValue) },
    { k: 'Parcel', v: rec.parcelId },
  ].filter(r => r.v)

  if (!rec.found) {
    return (
      <div style={{ ...card, marginBottom: '14px', borderColor: '#fed7aa', background: '#fff7ed' }}>
        <div style={{ fontWeight: 800, color: '#9a3412', fontSize: '15px' }}>Couldn't find that address</div>
        <p style={{ fontSize: '13px', color: '#7c2d12', lineHeight: 1.55, margin: '6px 0 0' }}>{rec.summary}</p>
        <p style={{ fontSize: '12px', color: '#9a3412', margin: '8px 0 0' }}>
          Check the street spelling and the city, or just describe the place and ask anyway — the advisor
          works fine without a record.
        </p>
        <button onClick={onRefresh} disabled={refreshing} style={{ ...secondaryBtn, marginTop: '10px' }}>
          {refreshing ? 'Looking…' : 'Try the lookup again'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ ...card, marginBottom: '14px', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '16px', color: NAVY, lineHeight: 1.3 }}>
            {rec.normalizedAddress || 'This property'}
          </div>
          {shape && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>{shape}</div>}
        </div>
        <span style={{ background: st.bg, color: st.fg, borderRadius: '999px', padding: '5px 11px', fontSize: '12px', fontWeight: 800, whiteSpace: 'nowrap' }}>
          {st.label}
        </span>
      </div>

      {rec.listPrice ? (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '28px', fontWeight: 800, color: NAVY, lineHeight: 1.1 }}>{usd(rec.listPrice)}</div>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '3px' }}>
            {['asking', perSqft ? `$${perSqft}/sq ft` : '', rec.daysOnMarket !== null ? `${rec.daysOnMarket} days on market` : ''].filter(Boolean).join('  ·  ')}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '12px', fontSize: '14px', fontWeight: 700, color: '#475569' }}>
          {rec.statusNote || 'No asking price found — it is not on the market right now.'}
        </div>
      )}
      {rec.listPrice && rec.statusNote && (
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{rec.statusNote}</div>
      )}
      {rec.priceHistoryNote && (
        <div style={{ fontSize: '12px', color: '#b45309', marginTop: '6px', fontWeight: 600 }}>{rec.priceHistoryNote}</div>
      )}

      {rec.summary && (
        <p style={{ fontSize: '13px', lineHeight: 1.6, color: '#334155', margin: '12px 0 0', paddingTop: '12px', borderTop: '1px solid #eef2f6' }}>
          {rec.summary}
        </p>
      )}

      {moneyRows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', marginTop: '12px' }}>
          {moneyRows.map(r => (
            <div key={r.k} style={{ background: '#f8fafc', borderRadius: '10px', padding: '8px 10px' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em' }}>{r.k}</div>
              <div style={{ fontSize: '13px', color: NAVY, fontWeight: 700, marginTop: '2px' }}>{r.v}</div>
            </div>
          ))}
        </div>
      )}

      {rec.watchOuts.length > 0 && (
        <div style={{ marginTop: '12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '12px', padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: '#9a3412', marginBottom: '6px' }}>Look at these hard</div>
          <Bullets items={rec.watchOuts} color="#7c2d12" />
        </div>
      )}

      {rec.unconfirmed.length > 0 && (
        <Fold title="Still needs a call — the lookup could not confirm this" count={rec.unconfirmed.length}>
          <Bullets items={rec.unconfirmed} color="#64748b" />
        </Fold>
      )}
      {rec.highlights.length > 0 && (
        <Fold title="What is good about it" count={rec.highlights.length}>
          <Bullets items={rec.highlights} color="#334155" />
        </Fold>
      )}
      {rec.extraFacts.length > 0 && (
        <Fold title="On the record" count={rec.extraFacts.length}>
          <div style={{ display: 'grid', gap: '6px' }}>
            {rec.extraFacts.map((f, i) => (
              <div key={i} style={{ fontSize: '13px', lineHeight: 1.5 }}>
                <span style={{ color: '#64748b', fontWeight: 700 }}>{f.label}: </span>
                <span style={{ color: NAVY }}>{f.value}</span>
              </div>
            ))}
          </div>
        </Fold>
      )}
      {rec.comps.length > 0 && (
        <Fold title="Nearby sales" count={rec.comps.length}>
          <div style={{ display: 'grid', gap: '8px' }}>
            {rec.comps.map((c, i) => (
              <div key={i}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: NAVY }}>{c.address}</div>
                <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>{c.detail}</div>
              </div>
            ))}
          </div>
        </Fold>
      )}
      {rec.marketNote && (
        <Fold title="The local market">
          <p style={{ fontSize: '13px', lineHeight: 1.6, color: '#334155', margin: 0 }}>{rec.marketNote}</p>
        </Fold>
      )}
      {rec.sources.length > 0 && (
        <Fold title="Where this came from" count={rec.sources.length}>
          <div style={{ display: 'grid', gap: '6px' }}>
            {rec.sources.map((src, i) => (
              <div key={i} style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
                {src.url
                  ? <a href={src.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', fontWeight: 700 }}>{src.label}</a>
                  : <span style={{ fontWeight: 700, color: '#475569' }}>{src.label}</span>}
                {src.asOf ? ` — ${src.asOf}` : ''}
              </div>
            ))}
          </div>
        </Fold>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #eef2f6' }}>
        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
          Pulled from public listings and county records{rec.lookedUpAt ? ` on ${new Date(rec.lookedUpAt).toLocaleDateString()}` : ''} · {rec.confidence} confidence
        </span>
        <button onClick={onRefresh} disabled={refreshing} style={{ ...speakerBtn, marginTop: 0, marginLeft: 'auto' }}>
          {refreshing ? 'Refreshing…' : '↻ Look it up again'}
        </button>
      </div>
    </div>
  )
}

// ── Property Advisor ──────────────────────────────────────────────────────
// Describe a property once, then keep asking about it. The advisor answers
// across structure, deal math and resale — the three things you otherwise have
// to call three different people about.
export default function PropertyAdvisor() {
  const { user } = useUser()
  const { getToken } = useAuth()
  const { tier } = useTier()
  const isPro = tier === 'pro'

  const [sessions, setSessions] = useState<AdvisorSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Kept with the id it belongs to: switching properties otherwise shows the
  // previous transcript for a frame before the new snapshot lands.
  const [transcript, setTranscript] = useState<{ sessionId: string; items: AdvisorMessage[] }>({ sessionId: '', items: [] })
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [needsUpgrade, setNeedsUpgrade] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(null)

  // Intake form
  const [location, setLocation] = useState('')
  const [propertyType, setPropertyType] = useState('')
  const [yearBuilt, setYearBuilt] = useState('')
  const [price, setPrice] = useState('')
  const [goal, setGoal] = useState<Goal>('buying')
  const [conditionNotes, setConditionNotes] = useState('')

  // ── Address lookup ──────────────────────────────────────────────────────
  const [addressInput, setAddressInput] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupStage, setLookupStage] = useState('')
  const [lookupError, setLookupError] = useState('')
  const stageRef = useRef<number | null>(null)
  // The mic is shared between asking a question and dictating an address, and
  // the recorder's onstop fires long after the tap that started it — a ref, not
  // state, so the handler reads what was true when recording began.
  const voiceForRef = useRef<'question' | 'address'>('question')

  // ── Voice ───────────────────────────────────────────────────────────────
  // One useVoiceOutput for the whole screen, not one per message: two hooks
  // means two voices talking over each other the moment someone taps a second
  // speaker button.
  const { speak, stop: stopSpeaking, isSpeaking, isLoading: voiceLoading, needsTap, engine, remainingChars } = useVoiceOutput()
  const [voicePhase, setVoicePhase] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [heard, setHeard] = useState('')
  const [voiceError, setVoiceError] = useState('')
  // Only ever read alongside isSpeaking, so a stale id after playback ends is
  // harmless — it saves an effect that would just be resetting state.
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  // Kept so a blocked autoplay can be retried on a tap. The hook reports the
  // block; it doesn't hold the words.
  const [lastSpoken, setLastSpoken] = useState('')

  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const tickRef = useRef<number | null>(null)
  const autoStopRef = useRef<number | null>(null)

  const micSupported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  // Never leave the mic hot or a timer running after this screen is gone.
  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current)
    if (autoStopRef.current) clearTimeout(autoStopRef.current)
    if (stageRef.current) clearInterval(stageRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  // Sessions. Sorted here rather than in the query so this doesn't need a
  // composite index — same approach as the rest of the app.
  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(
      query(collection(db, 'propertyAdvisorSessions'), where('createdBy', '==', user.id)),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as AdvisorSession))
        list.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        setSessions(list)
      },
      err => console.error('Advisor sessions listener failed:', err),
    )
    return unsub
  }, [user?.id])

  // The open session's transcript. Live, because the answer is written
  // server-side — the message appears when the function commits it.
  useEffect(() => {
    if (!activeId) return
    const unsub = onSnapshot(
      query(collection(db, 'propertyAdvisorSessions', activeId, 'messages'), orderBy('createdAt', 'asc')),
      snap => setTranscript({ sessionId: activeId, items: snap.docs.map(d => ({ id: d.id, ...d.data() } as AdvisorMessage)) }),
      err => console.error('Advisor messages listener failed:', err),
    )
    return unsub
  }, [activeId])

  const messages = transcript.sessionId === activeId ? transcript.items : []

  // How many free questions are left this month, so the count is honest before
  // the first question rather than only after one is spent.
  useEffect(() => {
    if (!user?.id) return
    const month = (() => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })()
    const unsub = onSnapshot(
      doc(db, 'advisorUsage', user.id, 'months', month),
      snap => {
        const used = (snap.data()?.messages as number | undefined) ?? 0
        setRemaining(Math.max(0, FREE_QUESTIONS_PER_MONTH - used))
      },
      // Absent doc is the normal case for a new user, not an error worth showing.
      () => setRemaining(FREE_QUESTIONS_PER_MONTH),
    )
    return unsub
  }, [user?.id])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy])

  const active = useMemo(() => sessions.find(s => s.id === activeId) || null, [sessions, activeId])

  const startSession = async () => {
    if (!user?.id) return
    const year = parseInt(yearBuilt, 10)
    const asking = parseFloat(price.replace(/[^0-9.]/g, ''))
    const nowISO = new Date().toISOString()
    const ref = await addDoc(collection(db, 'propertyAdvisorSessions'), {
      createdBy: user.id,
      createdAt: nowISO,
      updatedAt: nowISO,
      propertyContext: {
        location: location.trim() || null,
        propertyType: propertyType.trim() || null,
        yearBuilt: Number.isFinite(year) && year > 1500 ? year : null,
        priceContext: Number.isFinite(asking) && asking > 0 ? asking : null,
        userGoal: goal,
        conditionNotes: conditionNotes.trim() || null,
      },
    })
    setLocation(''); setPropertyType(''); setYearBuilt(''); setPrice(''); setConditionNotes(''); setGoal('buying')
    setCreating(false)
    setActiveId(ref.id)
  }

  // A lookup is eight searches, two model calls and a read of the county
  // records — a minute and a half is normal. A bare spinner reads as hung at
  // that length, so the stages say what it is actually off doing.
  const runLookup = async (raw: string, sessionId?: string) => {
    const address = raw.trim()
    if (!address || lookingUp) return
    setLookingUp(true); setLookupError(''); setError(''); setNeedsUpgrade(false)
    let i = 0
    setLookupStage(LOOKUP_STAGES[0])
    stageRef.current = window.setInterval(() => {
      i = Math.min(i + 1, LOOKUP_STAGES.length - 1)
      setLookupStage(LOOKUP_STAGES[i])
    }, 14000)
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Sign in again to look up a property.')
      // With no sessionId this creates the property for us — the lookup is the
      // intake form, so there is nothing to fill in first.
      const res = await lookupCallable({ clerkToken, input: { address, sessionId } })
      setRemaining(res.data.monthlyRemaining)
      setAddressInput('')
      setCreating(false)
      setActiveId(res.data.sessionId)
    } catch (err) {
      const code = (err as { code?: string })?.code || ''
      if (code.includes('permission-denied')) setNeedsUpgrade(true)
      else setLookupError((err as { message?: string })?.message || 'That lookup didn\'t go through. Try again.')
    } finally {
      if (stageRef.current) { clearInterval(stageRef.current); stageRef.current = null }
      setLookupStage('')
      setLookingUp(false)
    }
  }

  const send = async (text: string, speakBack = false) => {
    const question = text.trim()
    if (!question || !activeId || busy) return
    setBusy(true); setError(''); setNeedsUpgrade(false); setDraft('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Sign in again to ask the advisor.')
      const res = await askCallable({ clerkToken, input: { sessionId: activeId, message: question } })
      setRemaining(res.data.monthlyRemaining)
      // Asked out loud, answered out loud. The long version is already on
      // screen behind this — the spoken half is deliberately the short one.
      const spoken = (res.data.spoken || '').trim()
      if (speakBack && spoken) {
        setLastSpoken(spoken)
        setSpeakingId(null)
        // A phone may refuse to start audio this long after the tap that
        // started the recording. The hook catches that and asks for one more
        // tap rather than failing silently.
        void speak(spoken)
      }
    } catch (err) {
      const code = (err as { code?: string })?.code || ''
      const message = (err as { message?: string })?.message || 'Something went wrong. Try again.'
      // Out of free questions is not a failure — it's the upgrade moment.
      if (code.includes('permission-denied')) setNeedsUpgrade(true)
      setError(code.includes('permission-denied') ? '' : message)
    } finally {
      setBusy(false)
    }
  }

  // Tap to talk, tap to stop — walkie-talkie, not a phone call. Holding a
  // button down is wrong for this: the questions are long enough that a thumb
  // slipping mid-sentence loses the whole thing.
  const startListening = async (target: 'question' | 'address' = 'question') => {
    voiceForRef.current = target
    setVoiceError(''); setError(''); setHeard('')
    stopSpeaking()   // don't record the advisor answering the last question
    if (!micSupported) { setVoiceError('This browser can\'t use the mic — type the question instead.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = pickRecorderMimeType()
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstart = () => {
        setVoicePhase('listening')
        setElapsed(0)
        tickRef.current = window.setInterval(() => setElapsed(n => n + 1), 1000)
        autoStopRef.current = window.setTimeout(() => stopListening(), VOICE_MAX_SECONDS * 1000)
      }
      rec.onstop = async () => {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null }
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' })
        if (blob.size === 0) { setVoiceError('Didn\'t catch that — try again.'); setVoicePhase('idle'); return }
        await askByVoice(blob, rec.mimeType || mimeType)
      }
      rec.onerror = () => { setVoiceError('Recording error — try again.'); setVoicePhase('idle') }
      recRef.current = rec
      rec.start(1000)
    } catch {
      setVoiceError('Couldn\'t get to the mic. Allow microphone access, or type the question.')
      setVoicePhase('idle')
    }
  }

  const stopListening = () => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
  }

  // Speech in, the same question the Ask button sends, speech back out.
  const askByVoice = async (blob: Blob, mimeType: string) => {
    setVoicePhase('transcribing')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Sign in again to ask the advisor.')
      const audioBase64 = await fileToBase64(blob)
      const res = await transcribeCallable({ clerkToken, input: { audioBase64, mimeType } })
      const said = (res.data.transcript || '').trim()
      setVoicePhase('idle')
      if (!said) { setVoiceError('Couldn\'t make that out. Try again, or type it.'); return }
      // An address goes in the box and straight into a lookup; a question goes
      // to the advisor and comes back spoken.
      if (voiceForRef.current === 'address') {
        setAddressInput(said)
        await runLookup(said)
        return
      }
      setHeard(said)
      await send(said, true)
    } catch (err) {
      setVoicePhase('idle')
      setVoiceError(err instanceof Error ? err.message : 'That didn\'t go through. Try typing it.')
    }
  }

  // The short version, on demand, for any answer on screen — including ones
  // answered by typing, and ones from before voice existed.
  const speakAnswer = (m: AdvisorMessage) => {
    if (isSpeaking && speakingId === m.id) { stopSpeaking(); return }
    const text = (m.spokenContent || '').trim() || m.content.replace(/\*\*/g, '').slice(0, 600)
    setSpeakingId(m.id)
    setLastSpoken(text)
    void speak(text)
  }

  const removeSession = async (s: AdvisorSession) => {
    if (!confirm(`Delete the advisor session for ${sessionTitle(s)}? The conversation goes with it.`)) return
    try {
      // Firestore doesn't cascade: drop the transcript first, or it survives its
      // property as documents nothing can reach.
      const msgs = await getDocs(collection(db, 'propertyAdvisorSessions', s.id, 'messages'))
      await Promise.all(msgs.docs.map(m => deleteDoc(m.ref)))
      await deleteDoc(doc(db, 'propertyAdvisorSessions', s.id))
      if (activeId === s.id) setActiveId(null)
    } catch (err) {
      alert('Could not delete that session: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // ── Intake form ─────────────────────────────────────────────────────────
  if (creating || (!activeId && sessions.length === 0)) {
    return (
      <div style={page}>
        <h2 style={h2}>🏚️ Property Advisor</h2>
        <p style={sub}>
          Pull up to a house and put the address in. It goes and finds the place — what they're asking,
          what the house actually is, what sold nearby, and what nobody has told you yet. Then you can
          keep asking about it.
        </p>

        <div style={{ ...card, padding: '16px', marginBottom: '14px' }}>
          <Field label="Property address" hint="Street, city and state. The closer to exact, the better it finds the right house.">
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                value={addressInput}
                onChange={e => setAddressInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void runLookup(addressInput) }}
                placeholder="3400 Brunswick Rd, Greensboro, NC"
                disabled={lookingUp}
                style={{ ...input, flex: 1 }}
              />
              {micSupported && (
                <button
                  onClick={() => (voicePhase === 'listening' ? stopListening() : startListening('address'))}
                  disabled={lookingUp || voicePhase === 'transcribing'}
                  aria-label={voicePhase === 'listening' ? 'Stop and look it up' : 'Say the address'}
                  title={voicePhase === 'listening' ? 'Tap when you\'re done' : 'Say the address'}
                  style={{ ...primaryBtn, padding: '10px 14px', background: voicePhase === 'listening' ? '#dc2626' : ORANGE }}
                >
                  {voicePhase === 'listening' ? '⏹' : '🎤'}
                </button>
              )}
            </div>
          </Field>

          <button
            onClick={() => void runLookup(addressInput)}
            disabled={lookingUp || !addressInput.trim()}
            style={{ ...primaryBtn, marginTop: '12px', width: '100%', opacity: lookingUp || !addressInput.trim() ? 0.6 : 1 }}
          >
            {lookingUp ? 'Looking it up…' : 'Look up this address →'}
          </button>

          {lookingUp && (
            <div style={{ fontSize: '13px', color: '#9a3412', marginTop: '10px', fontWeight: 700 }}>
              {lookupStage}
              <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 400, marginTop: '3px' }}>
                Takes a minute or two — it's reading listings and county records, not guessing.
              </div>
            </div>
          )}
          {voicePhase === 'listening' && (
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '8px' }}>
              🎙 Listening — say the address, then tap ⏹ ({VOICE_MAX_SECONDS - elapsed}s left)
            </div>
          )}
          {voicePhase === 'transcribing' && (
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '8px' }}>⏳ Getting that down…</div>
          )}
          {voiceError && <div style={{ fontSize: '12px', color: '#b45309', marginTop: '8px' }}>⚠ {voiceError}</div>}
          {lookupError && <div style={{ fontSize: '12px', color: '#b45309', marginTop: '8px' }}>⚠ {lookupError}</div>}
          {needsUpgrade && (
            <div style={{ fontSize: '13px', color: '#9a3412', marginTop: '8px', fontWeight: 700 }}>
              That's your {FREE_QUESTIONS_PER_MONTH} free advisor pulls for the month. Pro makes it unlimited.
            </div>
          )}
        </div>

        <details style={{ marginBottom: '4px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 700, color: NAVY, marginBottom: '10px' }}>
            No address, or it's not on the market? Describe it instead
          </summary>

        <div style={{ ...card, display: 'grid', gap: '14px' }}>
          <Field label="Address or area" hint="City and state is plenty — no full address needed">
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Greensboro, NC" style={input} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
            <Field label="Property type">
              <input value={propertyType} onChange={e => setPropertyType(e.target.value)} placeholder="Single family, duplex…" style={input} />
            </Field>
            <Field label="Year built">
              <input value={yearBuilt} onChange={e => setYearBuilt(e.target.value)} inputMode="numeric" placeholder="1974" style={input} />
            </Field>
            <Field label="Asking / purchase price">
              <input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" placeholder="185,000" style={input} />
            </Field>
          </div>

          <Field label="What are you doing with it?">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {GOALS.map(g => (
                <button
                  key={g.key}
                  onClick={() => setGoal(g.key)}
                  style={{
                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer', fontSize: '14px', fontWeight: 700,
                    border: `1px solid ${goal === g.key ? ORANGE : '#e8ecf1'}`,
                    background: goal === g.key ? '#fff7ed' : 'white',
                    color: goal === g.key ? '#9a3412' : NAVY,
                  }}
                >
                  {g.label}
                  <span style={{ display: 'block', fontWeight: 500, fontSize: '11px', color: '#64748b' }}>{g.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Condition notes" hint="Anything you noticed — roof looks original, panel is a Federal Pacific, soft floor in the back bedroom">
            <textarea
              value={conditionNotes}
              onChange={e => setConditionNotes(e.target.value)}
              rows={4}
              placeholder="Roof looks original. Crawlspace smells damp. Kitchen is 1990s but functional."
              style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </Field>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={startSession} style={primaryBtn}>Start asking →</button>
            {sessions.length > 0 && (
              <button onClick={() => setCreating(false)} style={secondaryBtn}>Cancel</button>
            )}
          </div>
        </div>
        </details>

        <Disclaimer />
      </div>
    )
  }

  // ── Session list ────────────────────────────────────────────────────────
  if (!activeId) {
    return (
      <div style={page}>
        <h2 style={h2}>🏚️ Property Advisor</h2>
        <p style={sub}>Your properties. Pick one back up, or add another.</p>
        <button onClick={() => setCreating(true)} style={{ ...primaryBtn, marginBottom: '16px' }}>+ New property</button>

        <div style={{ display: 'grid', gap: '10px' }}>
          {sessions.map(s => (
            <div key={s.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' }}>
              <button onClick={() => setActiveId(s.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <div style={{ fontWeight: 800, fontSize: '15px', color: NAVY }}>{sessionTitle(s)}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  {[
                    s.propertyRecord?.listPrice ? `${money(s.propertyRecord.listPrice)} asking` : money(s.propertyContext?.priceContext),
                    s.propertyRecord ? STATUS_STYLE[s.propertyRecord.status]?.label : '',
                    s.propertyContext?.userGoal,
                  ].filter(Boolean).join(' · ')}
                </div>
                {s.lastMessagePreview && (
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.lastMessagePreview}
                  </div>
                )}
              </button>
              <button onClick={() => removeSession(s)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#94a3b8' }}>🗑</button>
            </div>
          ))}
        </div>

        <Disclaimer />
      </div>
    )
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  const ctx = active?.propertyContext ?? {}
  return (
    <div style={page}>
      <button onClick={() => setActiveId(null)} style={{ ...secondaryBtn, marginBottom: '12px' }}>← All properties</button>

      {active?.propertyRecord ? (
        <PropertyCard
          rec={active.propertyRecord}
          refreshing={lookingUp}
          onRefresh={() => void runLookup(active.propertyRecord?.normalizedAddress || ctx.location || '', active.id)}
        />
      ) : (
        <div style={{ ...card, padding: '14px 16px', marginBottom: '14px' }}>
          <div style={{ fontWeight: 800, fontSize: '16px', color: NAVY }}>{active ? sessionTitle(active) : 'Property'}</div>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            {[
              ctx.userGoal,
              ctx.propertyType,
              ctx.yearBuilt ? `built ${ctx.yearBuilt}` : '',
              money(ctx.priceContext),
            ].filter(Boolean).join(' · ')}
          </div>
          {/* Described by hand, so nothing has been looked up yet. If what they
              typed reads like a street address, offer to go find the house. */}
          {/\d/.test(ctx.location || '') && (
            <button
              onClick={() => void runLookup(ctx.location || '', active?.id)}
              disabled={lookingUp}
              style={{ ...secondaryBtn, marginTop: '10px' }}
            >
              {lookingUp ? (lookupStage || 'Looking…') : '🔎 Look this address up'}
            </button>
          )}
          {lookupError && <div style={{ fontSize: '12px', color: '#b45309', marginTop: '8px' }}>⚠ {lookupError}</div>}
        </div>
      )}

      <div ref={transcriptRef} style={{ display: 'grid', gap: '12px', maxHeight: '58vh', overflowY: 'auto', paddingRight: '4px' }}>
        {messages.length === 0 && !busy && (
          <div style={{ ...card, padding: '16px', background: '#fff7ed', borderColor: '#fed7aa' }}>
            <div style={{ fontWeight: 700, color: '#9a3412', marginBottom: '6px' }}>Ask it anything about this place.</div>
            <div style={{ fontSize: '13px', color: '#7c2d12' }}>
              Structure, the deal math, or how to sell it — it'll tell you which problems are walk-aways,
              which are price negotiations, and which to ignore.
            </div>
            <div style={{ fontSize: '13px', color: '#7c2d12', marginTop: '8px' }}>
              Hands full? Tap 🎤 and just ask. You get the short answer out loud and the whole thing in writing here.
            </div>
          </div>
        )}

        {messages.map(m => (
          <div
            key={m.id}
            style={{
              ...card,
              padding: '12px 14px',
              maxWidth: m.role === 'user' ? '85%' : '100%',
              marginLeft: m.role === 'user' ? 'auto' : 0,
              background: m.role === 'user' ? '#1a1f2e' : 'white',
              color: m.role === 'user' ? 'white' : NAVY,
            }}
          >
            {m.role === 'user' ? (
              <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</div>
            ) : (
              <>
                <AnswerText text={m.content} />
                <button
                  onClick={() => speakAnswer(m)}
                  disabled={voiceLoading && speakingId === m.id}
                  style={speakerBtn}
                  aria-label={isSpeaking && speakingId === m.id ? 'Stop reading' : 'Hear the short version'}
                >
                  {isSpeaking && speakingId === m.id
                    ? '⏹ Stop'
                    : voiceLoading && speakingId === m.id
                      ? '⏳ Getting it…'
                      : '🔊 Hear the short version'}
                </button>
              </>
            )}
          </div>
        ))}

        {busy && (
          <div style={{ ...card, padding: '12px 14px', color: '#64748b', fontSize: '14px' }}>
            Thinking it through…
          </div>
        )}
      </div>

      {needsUpgrade && (
        <div style={{ ...card, padding: '16px', marginTop: '14px', background: '#fff7ed', borderColor: ORANGE }}>
          <div style={{ fontWeight: 800, color: '#9a3412', marginBottom: '6px' }}>
            That's your {FREE_QUESTIONS_PER_MONTH} free questions this month.
          </div>
          <div style={{ fontSize: '13px', color: '#7c2d12', marginBottom: '12px' }}>
            Pro gets unlimited advisor questions on every property you look at — plus unlimited instant
            quotes and customer thank-you letters.
          </div>
          <button
            onClick={() => document.dispatchEvent(new Event('bp-go-settings'))}
            style={primaryBtn}
          >
            Go Pro — $19.99/mo
          </button>
        </div>
      )}

      {error && (
        <div style={{ ...card, padding: '12px 14px', marginTop: '12px', borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {messages.length === 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
          {QUICK_PROMPTS.map(q => (
            <button key={q.label} onClick={() => send(q.text)} disabled={busy} style={chipBtn}>{q.label}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', alignItems: 'flex-end' }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }}
          rows={2}
          placeholder="Ask about this property…"
          disabled={busy}
          style={{ ...input, flex: 1, resize: 'vertical', fontFamily: 'inherit' }}
        />
        {micSupported && (
          <button
            onClick={() => (voicePhase === 'listening' ? stopListening() : startListening('question'))}
            disabled={busy || voicePhase === 'transcribing'}
            aria-label={voicePhase === 'listening' ? 'Stop recording and ask' : 'Ask out loud'}
            title={voicePhase === 'listening' ? 'Tap when you\'re done talking' : 'Ask out loud'}
            style={{
              ...primaryBtn,
              minWidth: '58px',
              background: voicePhase === 'listening' ? '#dc2626' : 'white',
              color: voicePhase === 'listening' ? 'white' : NAVY,
              border: voicePhase === 'listening' ? 'none' : `2px solid ${ORANGE}`,
              opacity: busy || voicePhase === 'transcribing' ? 0.5 : 1,
            }}
          >
            {voicePhase === 'listening' ? `⏹ ${elapsed}s` : voicePhase === 'transcribing' ? '⏳' : '🎤'}
          </button>
        )}
        <button onClick={() => send(draft)} disabled={busy || voicePhase !== 'idle' || !draft.trim()} style={{ ...primaryBtn, opacity: busy || voicePhase !== 'idle' || !draft.trim() ? 0.5 : 1 }}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>

      <VoiceStatus
        phase={voicePhase}
        elapsed={elapsed}
        heard={heard}
        error={voiceError}
        needsTap={needsTap}
        onPlay={() => { if (lastSpoken) void speak(lastSpoken) }}
        engine={engine}
        remainingChars={remainingChars}
        micSupported={micSupported}
      />

      {!isPro && remaining !== null && (
        <div style={{ fontSize: '12px', color: remaining > 1 ? '#64748b' : '#b45309', marginTop: '8px', fontWeight: remaining > 1 ? 400 : 700 }}>
          {remaining} free question{remaining === 1 ? '' : 's'} left this month
        </div>
      )}

      <Disclaimer />
    </div>
  )
}

// The one strip under the composer that says what voice is doing. Kept in a
// single place so the mic, the transcription and the playback can't each grow
// their own status line in a different corner of the screen.
function VoiceStatus({
  phase, elapsed, heard, error, needsTap, onPlay, engine, remainingChars, micSupported,
}: {
  phase: 'idle' | 'listening' | 'transcribing'
  elapsed: number
  heard: string
  error: string
  needsTap: boolean
  onPlay: () => void
  engine: 'elevenlabs' | 'browser' | null
  remainingChars: number | null
  micSupported: boolean
}) {
  // A blocked autoplay is the common case on a phone: the tap that started the
  // recording is long expired by the time the answer comes back. The audio is
  // already downloaded, so this tap plays instantly.
  if (needsTap) {
    return (
      <button onClick={onPlay} style={{ ...primaryBtn, marginTop: '10px', display: 'block' }}>
        ▶ Hear the answer
      </button>
    )
  }

  const line =
    phase === 'listening' ? `🎙 Listening… tap ⏹ when you're done (${VOICE_MAX_SECONDS - elapsed}s left)`
      : phase === 'transcribing' ? '⏳ Getting that down…'
        : error ? `⚠ ${error}`
          : heard ? `You asked: "${heard}"`
            : engine === 'browser' ? 'The good voice is used up for the month — this is the phone\'s own.'
              : remainingChars !== null && remainingChars < 600 ? 'Spoken answers are nearly out for the month.'
                : micSupported ? 'Or tap 🎤 to ask out loud — short answer spoken, full detail here.'
                  : ''

  if (!line) return null
  return (
    <div style={{ fontSize: '12px', color: error ? '#b45309' : '#64748b', marginTop: '10px', lineHeight: 1.5 }}>
      {line}
    </div>
  )
}

// Always visible, on every view of this feature — the advice here is structural
// and financial judgment, and the app is not the licensed party.
function Disclaimer() {
  return (
    <p style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.5, marginTop: '18px', borderTop: '1px solid #e8ecf1', paddingTop: '12px' }}>
      Educational guidance only — not a substitute for a licensed inspector, appraiser, contractor, or
      real estate attorney. Verify anything deal-critical before you commit money to it.
    </p>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: NAVY, marginBottom: '4px' }}>{label}</span>
      {hint && <span style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '6px' }}>{hint}</span>}
      {children}
    </label>
  )
}

const page: React.CSSProperties = { padding: 'clamp(12px, 3vw, 28px)', maxWidth: '860px', margin: '0 auto' }
const h2: React.CSSProperties = { fontSize: '24px', fontWeight: 800, margin: '0 0 4px', color: NAVY }
const sub: React.CSSProperties = { margin: '0 0 16px', color: '#64748b', fontSize: '14px', lineHeight: 1.5 }
const card: React.CSSProperties = { background: 'white', border: '1px solid #e8ecf1', borderRadius: '16px', boxShadow: '0 1px 2px rgba(15,23,42,0.04)', padding: '18px' }
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid #e8ecf1', fontSize: '14px', color: NAVY, background: 'white', boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = { background: ORANGE, color: 'white', border: 'none', borderRadius: '10px', padding: '12px 18px', fontSize: '14px', fontWeight: 800, cursor: 'pointer' }
const secondaryBtn: React.CSSProperties = { background: 'white', color: NAVY, border: '1px solid #e8ecf1', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }
// Deliberately quiet — it sits under every answer, and the answer is the point.
const speakerBtn: React.CSSProperties = { marginTop: '4px', background: 'none', border: 'none', padding: 0, color: '#64748b', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }
const chipBtn: React.CSSProperties = { background: 'white', color: NAVY, border: '1px solid #e8ecf1', borderRadius: '999px', padding: '8px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
