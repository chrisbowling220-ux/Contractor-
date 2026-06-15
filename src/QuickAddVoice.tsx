import { useEffect, useRef, useState } from 'react'
import { useUser, useAuth } from '@clerk/clerk-react'
import { httpsCallable } from 'firebase/functions'
import { collection, addDoc } from 'firebase/firestore'
import { functions, db } from './firebase'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'
const AUDIO_MAX_SECONDS = 20

const transcribeCallable = httpsCallable<
  { clerkToken: string; input: { audioBase64: string; mimeType: string } },
  { transcript: string }
>(functions, 'transcribeAudio')

const parseCallable = httpsCallable<
  { clerkToken: string; input: { transcript: string; todayISO: string } },
  { kind: 'job' | 'event' | 'reminder'; title: string; date: string; time: string; notes: string; needsDate: boolean }
>(functions, 'parseCalendarEntry')

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
function todayLocalISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Parsed = { kind: 'job' | 'event' | 'reminder'; title: string; date: string; time: string; notes: string; needsDate: boolean }
type Phase = 'idle' | 'listening' | 'thinking' | 'review' | 'saving' | 'done'

// Voice "Quick Add" — tap the mic, say what to add ("job for the Miller bathroom
// next Tuesday at 9am" / "remind me to order tile on the 15th"), and it lands on
// the calendar. The contractor reviews the parsed entry, can tweak it, set an
// early reminder, and save. Also reachable as a plain typed entry.
export default function QuickAddVoice({ onClose }: { onClose: () => void }) {
  const { user } = useUser()
  const { getToken } = useAuth()
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [remind, setRemind] = useState('1') // days before; '' = none
  const [typed, setTyped] = useState('')

  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const autoStopRef = useRef<number | null>(null)

  const audioSupported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  // Clean up mic/timers on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (autoStopRef.current) clearTimeout(autoStopRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  const startListening = async () => {
    setError('')
    if (!audioSupported) { setError('Voice not supported in this browser — type it below instead.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = pickRecorderMimeType()
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstart = () => {
        setPhase('listening')
        setElapsed(0)
        timerRef.current = window.setInterval(() => setElapsed(s => s + 1), 1000)
        autoStopRef.current = window.setTimeout(() => stopListening(), AUDIO_MAX_SECONDS * 1000)
      }
      rec.onstop = async () => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null }
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' })
        if (blob.size === 0) { setError('Didn\'t catch that — try again.'); setPhase('idle'); return }
        await transcribeAndParse(blob, rec.mimeType || mimeType)
      }
      rec.onerror = () => { setError('Recording error — try again.'); setPhase('idle') }
      recRef.current = rec
      rec.start(1000)
    } catch (err) {
      setError(`Couldn't start the mic: ${err instanceof Error ? err.message : 'permission denied'}. Allow microphone access, or type it below.`)
      setPhase('idle')
    }
  }

  const stopListening = () => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
  }

  const transcribeAndParse = async (blob: Blob, mimeType: string) => {
    setPhase('thinking')
    setError('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const audioBase64 = await fileToBase64(blob)
      const tRes = await transcribeCallable({ clerkToken, input: { audioBase64, mimeType } })
      const text = (tRes.data.transcript || '').trim()
      if (!text) { setError('Couldn\'t hear anything. Try again or type it below.'); setPhase('idle'); return }
      await parseText(text, clerkToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try typing it below.')
      setPhase('idle')
    }
  }

  const parseText = async (text: string, token?: string) => {
    setPhase('thinking')
    setError('')
    try {
      const clerkToken = token || await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const pRes = await parseCallable({ clerkToken, input: { transcript: text, todayISO: todayLocalISO() } })
      const p = pRes.data
      setParsed(p)
      setRemind(p.kind === 'reminder' ? '0' : '1')
      setPhase('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn\'t understand that. Try again.')
      setPhase('idle')
    }
  }

  const save = async () => {
    if (!user?.id || !parsed) return
    setPhase('saving')
    try {
      await addDoc(collection(db, 'calendarEvents'), {
        date: parsed.date,
        title: parsed.title.trim() || 'Untitled',
        kind: parsed.kind,
        ...(parsed.time ? { time: parsed.time } : {}),
        ...(parsed.notes?.trim() ? { notes: parsed.notes.trim() } : {}),
        ...(remind !== '' ? { remindDaysBefore: Number(remind) } : {}),
        createdAt: new Date().toISOString(),
        createdBy: user.id,
      })
      setPhase('done')
      setTimeout(onClose, 1100)
    } catch (err) {
      setError('Could not save: ' + (err instanceof Error ? err.message : String(err)))
      setPhase('review')
    }
  }

  const input: React.CSSProperties = { width: '100%', padding: '11px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '15px', boxSizing: 'border-box' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }
  const prettyDate = parsed ? new Date(parsed.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : ''

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 400, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '460px', margin: '40px auto', background: '#f8fafc', borderRadius: '16px', overflow: 'hidden' }}>
        <div style={{ background: NAVY, color: 'white', padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '17px', color: ORANGE }}>⚡ Quick Add to Calendar</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '22px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '20px 18px' }}>
          {error && <div style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', fontSize: '13px' }}>{error}</div>}

          {/* ── Mic stage (idle / listening / thinking) ── */}
          {(phase === 'idle' || phase === 'listening' || phase === 'thinking') && (
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: '0 0 16px', color: '#64748b', fontSize: '14px' }}>
                Tap the mic and just say it — like<br />
                <em>"Job for the Miller bathroom next Tuesday at 9am"</em><br />
                or <em>"Remind me to order tile on the 15th."</em>
              </p>

              <button
                onClick={phase === 'listening' ? stopListening : startListening}
                disabled={phase === 'thinking'}
                style={{
                  width: '110px', height: '110px', borderRadius: '50%', border: 'none', cursor: phase === 'thinking' ? 'default' : 'pointer',
                  background: phase === 'listening' ? '#dc2626' : phase === 'thinking' ? '#cbd5e1' : ORANGE,
                  color: 'white', fontSize: '42px', boxShadow: '0 8px 24px rgba(249,115,22,0.35)',
                  animation: phase === 'listening' ? 'qa-pulse 1.2s infinite' : 'none',
                }}
              >
                {phase === 'thinking' ? '⏳' : phase === 'listening' ? '⏹' : '🎙️'}
              </button>

              <div style={{ marginTop: '14px', fontSize: '14px', fontWeight: 600, color: NAVY, minHeight: '20px' }}>
                {phase === 'listening' ? `Listening… ${AUDIO_MAX_SECONDS - elapsed}s` : phase === 'thinking' ? 'Got it — figuring out the details…' : 'Tap to talk'}
              </div>

              {/* Type-instead fallback */}
              {phase === 'idle' && (
                <div style={{ marginTop: '20px', borderTop: '1px solid #e2e8f0', paddingTop: '16px', textAlign: 'left' }}>
                  <label style={label}>…or just type it</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="e.g. Inspection Friday at 2pm" style={input}
                      onKeyDown={e => { if (e.key === 'Enter' && typed.trim()) parseText(typed.trim()) }} />
                    <button onClick={() => typed.trim() && parseText(typed.trim())} disabled={!typed.trim()} style={{ background: typed.trim() ? NAVY : '#cbd5e1', color: 'white', border: 'none', borderRadius: '8px', padding: '0 16px', cursor: typed.trim() ? 'pointer' : 'default', fontWeight: 700 }}>Add</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Review stage ── */}
          {(phase === 'review' || phase === 'saving') && parsed && (
            <div>
              <p style={{ ...label, marginBottom: '10px' }}>Here's what I got — fix anything, then save</p>

              <div style={{ marginBottom: '12px' }}>
                <label style={label}>What is it?</label>
                <input value={parsed.title} onChange={e => setParsed({ ...parsed, title: e.target.value })} style={input} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={label}>Type</label>
                  <select value={parsed.kind} onChange={e => setParsed({ ...parsed, kind: e.target.value as Parsed['kind'] })} style={input}>
                    <option value="job">Job</option>
                    <option value="event">Appointment / Event</option>
                    <option value="reminder">Reminder</option>
                  </select>
                </div>
                <div>
                  <label style={label}>Time</label>
                  <input type="time" value={parsed.time} onChange={e => setParsed({ ...parsed, time: e.target.value })} style={input} />
                </div>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={label}>Date {parsed.needsDate && <span style={{ color: '#dc2626', textTransform: 'none' }}>— please confirm</span>}</label>
                <input type="date" value={parsed.date} onChange={e => setParsed({ ...parsed, date: e.target.value, needsDate: false })} style={input} />
                {!parsed.needsDate && <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px', fontWeight: 600 }}>📅 {prettyDate}</div>}
              </div>

              <div style={{ marginBottom: '14px' }}>
                <label style={label}>🔔 Warn me early so it doesn't slip by</label>
                <select value={remind} onChange={e => setRemind(e.target.value)} style={input}>
                  <option value="">No early reminder</option>
                  <option value="0">Morning of (plus the 6am alert)</option>
                  <option value="1">1 day before</option>
                  <option value="2">2 days before</option>
                  <option value="3">3 days before</option>
                  <option value="7">1 week before</option>
                </select>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>You'll also get a 6am heads-up the morning of, no matter what.</div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => { setParsed(null); setPhase('idle') }} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '12px 16px', cursor: 'pointer', fontWeight: 600 }}>Redo</button>
                <button onClick={save} disabled={phase === 'saving' || !parsed.title.trim()} style={{ flex: 1, background: phase === 'saving' || !parsed.title.trim() ? '#cbd5e1' : '#16a34a', color: 'white', border: 'none', borderRadius: '8px', padding: '12px', cursor: phase === 'saving' ? 'default' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
                  {phase === 'saving' ? 'Saving…' : '✓ Add to Calendar'}
                </button>
              </div>
            </div>
          )}

          {/* ── Done ── */}
          {phase === 'done' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '48px' }}>✅</div>
              <p style={{ margin: '10px 0 0', fontWeight: 700, color: NAVY, fontSize: '16px' }}>Added to your calendar!</p>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes qa-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5) } 50% { box-shadow: 0 0 0 16px rgba(220,38,38,0) } }`}</style>
    </div>
  )
}
