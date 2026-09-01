import { useEffect, useMemo, useRef, useState } from 'react'
import { useUser, useAuth } from '@clerk/clerk-react'
import { collection, query, where, onSnapshot, addDoc, deleteDoc, doc, getDocs, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase'
import { useTier } from './lib/useTier'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

// Mirrors ADVISOR_FREE_MESSAGES_PER_MONTH in functions/src/index.ts. The server
// is what enforces it; this copy only shapes what the UI promises.
const FREE_QUESTIONS_PER_MONTH = 5

const askCallable = httpsCallable<
  { clerkToken: string; input: { sessionId: string; message: string } },
  { reply: string; monthlyRemaining: number | null; tier: 'free' | 'pro' }
>(functions, 'askPropertyAdvisor')

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
}

interface AdvisorMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
}

const GOALS: { key: Goal; label: string; hint: string }[] = [
  { key: 'buying', label: 'Buying', hint: 'Should I move forward on this one?' },
  { key: 'flipping', label: 'Flipping', hint: 'Does the deal actually pencil out?' },
  { key: 'selling', label: 'Selling', hint: 'How do I price and list it?' },
  { key: 'researching', label: 'Just looking', hint: 'Getting a feel for it' },
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

  const transcriptRef = useRef<HTMLDivElement | null>(null)

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

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || !activeId || busy) return
    setBusy(true); setError(''); setNeedsUpgrade(false); setDraft('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Sign in again to ask the advisor.')
      const res = await askCallable({ clerkToken, input: { sessionId: activeId, message: question } })
      setRemaining(res.data.monthlyRemaining)
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
          Describe the property once. Then ask anything about it — what's wrong with it, whether the
          numbers work, how to sell it. Everything's optional except what you're trying to do.
        </p>

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
                  {[s.propertyContext?.userGoal, money(s.propertyContext?.priceContext)].filter(Boolean).join(' · ')}
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
      </div>

      <div ref={transcriptRef} style={{ display: 'grid', gap: '12px', maxHeight: '58vh', overflowY: 'auto', paddingRight: '4px' }}>
        {messages.length === 0 && !busy && (
          <div style={{ ...card, padding: '16px', background: '#fff7ed', borderColor: '#fed7aa' }}>
            <div style={{ fontWeight: 700, color: '#9a3412', marginBottom: '6px' }}>Ask it anything about this place.</div>
            <div style={{ fontSize: '13px', color: '#7c2d12' }}>
              Structure, the deal math, or how to sell it — it'll tell you which problems are walk-aways,
              which are price negotiations, and which to ignore.
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
            {m.role === 'user'
              ? <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</div>
              : <AnswerText text={m.content} />}
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
        <button onClick={() => send(draft)} disabled={busy || !draft.trim()} style={{ ...primaryBtn, opacity: busy || !draft.trim() ? 0.5 : 1 }}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>

      {!isPro && remaining !== null && (
        <div style={{ fontSize: '12px', color: remaining > 1 ? '#64748b' : '#b45309', marginTop: '8px', fontWeight: remaining > 1 ? 400 : 700 }}>
          {remaining} free question{remaining === 1 ? '' : 's'} left this month
        </div>
      )}

      <Disclaimer />
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
const chipBtn: React.CSSProperties = { background: 'white', color: NAVY, border: '1px solid #e8ecf1', borderRadius: '999px', padding: '8px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
