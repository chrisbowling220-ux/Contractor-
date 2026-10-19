// Public Safe-to-Spend calculator at /safe-to-spend (no sign-in).
// "I just got paid — how much is the tax man's, and how much is mine?"
// The math lives in src/lib/setaside/taxEngine.ts; copy in content.ts.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { colors, radius, shadow } from './theme'
import { computeAnnual, computePayment, netBucket, nextDueDate } from './lib/setaside/taxEngine'
import { TAX_YEARS, taxYearFor } from './lib/setaside/taxYears'
import type { FilingStatus, StateOption } from './lib/setaside/types'
import { PAGE_URL, TRADES, disclaimer, faq, meta, writeOffs } from './lib/setaside/content'
import { MIN_FILL_MS, isValidEmail, joinWaitlist } from './lib/setaside/waitlist'

const NAVY = colors.navy
const ORANGE = colors.accent
// Brand orange is too light for text/buttons on white (2.8:1). This deeper
// shade keeps the look and passes WCAG AA (5.2:1).
const ORANGE_INK = '#c2410c'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const money = (n: number) => usd.format(Number.isFinite(n) ? n : 0)

function parseMoney(s: string): number {
  const n = parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

type Tab = 'payment' | 'year'
type StateKind = StateOption['kind']

const CSS = `
.sts * { box-sizing: border-box; }
.sts-input { width: 100%; min-height: 56px; padding: 12px 14px; font-size: 20px; font-weight: 600; color: ${colors.text};
  background: #fff; border: 2px solid #cbd5e1; border-radius: ${radius.md}; }
.sts-input:focus { border-color: ${ORANGE_INK}; outline: 3px solid rgba(194,65,12,0.25); outline-offset: 0; }
.sts-money { position: relative; }
.sts-money > span { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-size: 20px; font-weight: 600; color: ${colors.muted}; pointer-events: none; }
.sts-money > input { padding-left: 32px; }
.sts-select { appearance: auto; font-weight: 600; font-size: 18px; }
.sts-tab { flex: 1; min-height: 52px; border: 0; border-radius: 10px; font-size: 17px; font-weight: 700; cursor: pointer; background: transparent; color: #475569; }
.sts-tab[aria-selected="true"] { background: #fff; color: ${colors.text}; box-shadow: ${shadow.sm}; }
.sts-tab:focus-visible, .sts summary:focus-visible, .sts-btn:focus-visible, .sts a:focus-visible, .sts-radio:focus-within { outline: 3px solid ${ORANGE_INK}; outline-offset: 2px; }
.sts summary { cursor: pointer; min-height: 48px; display: flex; align-items: center; gap: 8px; font-weight: 700; list-style: none; }
.sts summary::-webkit-details-marker { display: none; }
.sts summary::before { content: '▸'; display: inline-block; transition: transform .15s; color: ${ORANGE_INK}; }
.sts details[open] > summary::before { transform: rotate(90deg); }
.sts-btn { width: 100%; min-height: 56px; border: 0; border-radius: ${radius.md}; background: ${ORANGE_INK}; color: #fff; font-size: 18px; font-weight: 800; cursor: pointer; }
.sts-btn:disabled { opacity: .7; cursor: progress; }
.sts-radio { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 0 12px; border: 2px solid #cbd5e1; border-radius: ${radius.md}; background: #fff; cursor: pointer; font-weight: 600; }
.sts-radio:has(input:checked) { border-color: ${ORANGE_INK}; background: ${colors.accentSoft}; }
.sts-radio input { width: 20px; height: 20px; accent-color: ${ORANGE_INK}; }
.sts-hp { position: absolute !important; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.sts a { color: ${ORANGE_INK}; }
`

function useSeoTags() {
  useEffect(() => {
    const prevTitle = document.title
    document.title = meta.title
    const set = (selector: string, attr: string, value: string) => {
      const el = document.head.querySelector(selector)
      const prev = el?.getAttribute(attr) ?? null
      el?.setAttribute(attr, value)
      return () => { if (el && prev !== null) el.setAttribute(attr, prev) }
    }
    const undo = [
      set('meta[name="description"]', 'content', meta.description),
      set('link[rel="canonical"]', 'href', PAGE_URL),
    ]
    return () => { document.title = prevTitle; undo.forEach(u => u()) }
  }, [])
}

function MoneyField({ id, label, hint, value, onChange, placeholder }: {
  id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label htmlFor={id} style={{ display: 'block', fontWeight: 700, fontSize: '16px', marginBottom: '6px', color: colors.text }}>{label}</label>
      {hint && <p id={`${id}-hint`} style={{ margin: '0 0 6px', fontSize: '14px', color: colors.muted }}>{hint}</p>}
      <div className="sts-money">
        <span aria-hidden="true">$</span>
        <input
          id={id}
          className="sts-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder ?? '0'}
          value={value}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={e => onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
        />
      </div>
    </div>
  )
}

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: radius.lg, boxShadow: shadow.md, padding: '20px', marginBottom: '20px', ...style }}>
      {children}
    </section>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: `1px solid ${colors.border}`, fontWeight: strong ? 800 : 500 }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

function Waitlist({ filingStatus, stateKind, annualNet }: { filingStatus: FilingStatus; stateKind: StateKind; annualNet: number }) {
  const loadedAt = useRef(0)
  useEffect(() => { loadedAt.current = Date.now() }, [])
  const [email, setEmail] = useState('')
  const [trade, setTrade] = useState('')
  const [firstName, setFirstName] = useState('')
  const [honey, setHoney] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'done'>('idle')
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (honey) { setStatus('done'); return } // bots fill every field; pretend it worked
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return }
    if (!trade) { setError('Pick your trade.'); return }
    if (Date.now() - loadedAt.current < MIN_FILL_MS) { setError('Hang on a second, then tap Get Early Access again.'); return }
    setStatus('saving')
    try {
      await joinWaitlist({ email, trade, firstName, filingStatus, state: stateKind, annualNetBucket: netBucket(annualNet) })
      setStatus('done')
    } catch {
      setStatus('idle')
      setError('Something went wrong saving that. Check your connection and try again.')
    }
  }

  const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 700, marginBottom: '6px' }

  return (
    <Card style={{ borderColor: '#fed7aa', background: '#fffaf5' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '22px', lineHeight: 1.25 }}>Want this done automatically on every payment?</h2>
      <p style={{ margin: '0 0 16px', color: colors.muted, fontSize: '16px' }}>Join the 1099 Set-Aside early-access list.</p>
      {status === 'done' ? (
        <p role="status" style={{ margin: 0, padding: '16px', borderRadius: radius.md, background: '#dcfce7', color: '#14532d', fontWeight: 700, fontSize: '17px' }}>
          ✅ You're on the list. We'll email you when it's ready.
        </p>
      ) : (
        <form onSubmit={submit} noValidate>
          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="wl-email" style={labelStyle}>Email</label>
            <input id="wl-email" className="sts-input" type="email" inputMode="email" autoComplete="email" required
              value={email} onChange={e => setEmail(e.target.value)} aria-invalid={error.startsWith('Enter') || undefined} />
          </div>
          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="wl-trade" style={labelStyle}>Your trade</label>
            <select id="wl-trade" className="sts-input sts-select" required value={trade} onChange={e => setTrade(e.target.value)}>
              <option value="">Choose one…</option>
              {TRADES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <label htmlFor="wl-name" style={labelStyle}>First name <span style={{ fontWeight: 500, color: colors.muted }}>(optional)</span></label>
            <input id="wl-name" className="sts-input" type="text" autoComplete="given-name" value={firstName} onChange={e => setFirstName(e.target.value)} />
          </div>
          {/* Honeypot: hidden from people and screen readers; bots fill it. */}
          <div className="sts-hp" aria-hidden="true">
            <label htmlFor="wl-company">Company</label>
            <input id="wl-company" type="text" tabIndex={-1} autoComplete="off" value={honey} onChange={e => setHoney(e.target.value)} />
          </div>
          {error && <p role="alert" style={{ margin: '0 0 12px', color: '#b91c1c', fontWeight: 600 }}>{error}</p>}
          <button type="submit" className="sts-btn" disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Get Early Access'}
          </button>
          <p style={{ margin: '10px 0 0', fontSize: '13px', color: colors.muted }}>No spam. We'll only email you about the 1099 Set-Aside app. See our <a href="/privacy">Privacy Policy</a>.</p>
        </form>
      )}
    </Card>
  )
}

export default function SafeToSpend() {
  useSeoTags()
  const today = useMemo(() => new Date(), [])
  const config = taxYearFor(today)
  const dueIso = nextDueDate(today, Object.values(TAX_YEARS))

  const [tab, setTab] = useState<Tab>('payment')
  const [payment, setPayment] = useState('')
  const [materials, setMaterials] = useState('')
  const [yearNet, setYearNet] = useState('50,000')
  const [gross, setGross] = useState('')
  const [expenses, setExpenses] = useState('')
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single')
  const [stateKind, setStateKind] = useState<StateKind>('nc')
  const [otherPct, setOtherPct] = useState('5')
  const [otherIncome, setOtherIncome] = useState('')

  const state: StateOption = stateKind === 'other' ? { kind: 'other', ratePct: parseMoney(otherPct) } : { kind: stateKind }
  const common = { filingStatus, state, otherIncome: parseMoney(otherIncome), config }

  const view = (() => {
    if (tab === 'payment') {
      const p = computePayment({ ...common, payment: parseMoney(payment), materials: parseMoney(materials), annualNet: parseMoney(yearNet) })
      return {
        yours: p.yoursToSpend, setAside: p.setAside, rate: p.rate, covering: p.coveringCosts,
        breakdown: p.breakdown, qbiSkipped: p.annual.qbiSkipped, qbiThreshold: p.annual.qbiThreshold,
        annualNet: parseMoney(yearNet), hasInput: parseMoney(payment) > 0,
      }
    }
    const net = parseMoney(gross) - parseMoney(expenses)
    const a = computeAnnual({ ...common, net })
    return {
      yours: Math.max(0, net - a.setAside), setAside: a.setAside, rate: a.rate, covering: Math.min(parseMoney(expenses), parseMoney(gross)),
      breakdown: {
        seTax: a.seTax, federalIncomeTax: a.federalIncomeTax, stateIncomeTax: a.stateIncomeTax,
        cushion: Math.max(0, Math.round((a.setAside - a.totalTax) * 100) / 100),
      },
      qbiSkipped: a.qbiSkipped, qbiThreshold: a.qbiThreshold, annualNet: net, hasInput: parseMoney(gross) > 0,
    }
  })()

  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ payment: null, year: null })
  const onTabKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next: Tab = e.key === 'Home' ? 'payment' : e.key === 'End' ? 'year' : tab === 'payment' ? 'year' : 'payment'
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const pct = Math.round(view.rate * 100)
  const stateLabel = stateKind === 'nc' ? 'NC income tax' : stateKind === 'other' ? 'State income tax' : 'State income tax (none)'

  return (
    <div className="sts" style={{ background: colors.bg, minHeight: '100vh', color: colors.text }}>
      <style>{CSS}</style>

      <header style={{ background: NAVY, color: 'white', padding: '16px' }}>
        <div style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'white', textDecoration: 'none' }}>
            <span aria-hidden="true" style={{ width: '40px', height: '40px', background: ORANGE, borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '20px' }}>B</span>
            <span>
              <span style={{ display: 'block', fontWeight: 800, fontSize: '20px' }}>BuildPro<span style={{ color: ORANGE }}>+</span></span>
              <span style={{ display: 'block', fontSize: '12px', color: '#cbd5e1' }}>Free Tools</span>
            </span>
          </a>
        </div>
      </header>

      <main style={{ maxWidth: '640px', margin: '0 auto', padding: '20px 16px 40px' }}>
        <h1 style={{ fontSize: 'clamp(30px, 8vw, 40px)', lineHeight: 1.1, margin: '4px 0 10px', fontWeight: 800, letterSpacing: '-0.5px' }}>{meta.h1}</h1>
        <p style={{ fontSize: '18px', lineHeight: 1.45, color: '#334155', margin: '0 0 20px' }}>{meta.subhead}</p>

        <Card>
          <div role="tablist" aria-label="What are you figuring?" style={{ display: 'flex', gap: '4px', padding: '4px', background: colors.surfaceAlt, borderRadius: '12px', marginBottom: '20px' }}>
            {(['payment', 'year'] as Tab[]).map(t => (
              <button key={t} ref={el => { tabRefs.current[t] = el }} id={`tab-${t}`} role="tab" type="button" className="sts-tab"
                aria-selected={tab === t} aria-controls="sts-panel" tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)} onKeyDown={onTabKey}>
                {t === 'payment' ? 'This Payment' : 'Whole Year'}
              </button>
            ))}
          </div>

          <div id="sts-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === 'payment' ? (
              <>
                <MoneyField id="pay" label="Payment received" value={payment} onChange={setPayment} placeholder="e.g. 2,000" />
                <MoneyField id="mat" label="Materials/expenses on this job (optional)" value={materials} onChange={setMaterials} />
                <MoneyField id="yr" label="About how much will you clear this year after expenses?"
                  hint="Used to find your tax rate. A rough guess is fine." value={yearNet} onChange={setYearNet} />
              </>
            ) : (
              <>
                <MoneyField id="gross" label={`Expected ${config.year} gross 1099 income`} value={gross} onChange={setGross} placeholder="e.g. 60,000" />
                <MoneyField id="exp" label={`Expected ${config.year} business expenses`} value={expenses} onChange={setExpenses} />
              </>
            )}
          </div>

          <details style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '4px' }}>
            <summary>More options</summary>
            <fieldset style={{ border: 0, padding: 0, margin: '8px 0 16px' }}>
              <legend style={{ fontWeight: 700, marginBottom: '8px' }}>Filing status</legend>
              <div style={{ display: 'grid', gap: '8px' }}>
                {([['single', 'Single'], ['mfj', 'Married filing jointly'], ['hoh', 'Head of household']] as [FilingStatus, string][]).map(([v, l]) => (
                  <label key={v} className="sts-radio">
                    <input type="radio" name="filing" value={v} checked={filingStatus === v} onChange={() => setFilingStatus(v)} /> {l}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
              <legend style={{ fontWeight: 700, marginBottom: '8px' }}>State</legend>
              <div style={{ display: 'grid', gap: '8px' }}>
                {([['nc', 'North Carolina'], ['none', 'No state income tax'], ['other', 'Other (enter a flat %)']] as [StateKind, string][]).map(([v, l]) => (
                  <label key={v} className="sts-radio">
                    <input type="radio" name="state" value={v} checked={stateKind === v} onChange={() => setStateKind(v)} /> {l}
                  </label>
                ))}
              </div>
              {stateKind === 'other' && (
                <div style={{ marginTop: '12px' }}>
                  <label htmlFor="otherpct" style={{ display: 'block', fontWeight: 700, marginBottom: '6px' }}>Your state's flat rate (%)</label>
                  <input id="otherpct" className="sts-input" type="text" inputMode="decimal" value={otherPct}
                    onChange={e => setOtherPct(e.target.value.replace(/[^0-9.]/g, ''))} style={{ maxWidth: '160px' }} />
                </div>
              )}
            </fieldset>
            <MoneyField id="other" label="Other income this year" hint="Like a W-2 job or a spouse's wages." value={otherIncome} onChange={setOtherIncome} />
          </details>
        </Card>

        <Card style={{ background: NAVY, color: 'white', border: 0 }}>
          <div aria-live="polite">
            <p style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#cbd5e1' }}>Yours to spend</p>
            <p style={{ margin: '2px 0 12px', fontSize: 'clamp(44px, 14vw, 64px)', lineHeight: 1.05, fontWeight: 900, letterSpacing: '-1px', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
              {money(view.yours)}
            </p>
            <p style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700 }}>
              Set aside for taxes: <span style={{ color: '#fdba74' }}>{money(view.setAside)}</span>
              <span style={{ fontWeight: 500, color: '#cbd5e1' }}> ({pct}% of your profit)</span>
            </p>
            {view.covering > 0 && (
              <p style={{ margin: '0 0 4px', fontSize: '16px', color: '#cbd5e1' }}>
                {money(view.covering)} is covering your costs, not spending money.
              </p>
            )}
          </div>

          <details style={{ marginTop: '12px', background: 'rgba(255,255,255,0.06)', borderRadius: radius.md, padding: '4px 14px 8px' }}>
            <summary style={{ color: 'white' }}>See the breakdown</summary>
            <div style={{ fontSize: '16px' }}>
              <Row label="Self-employment tax" value={money(view.breakdown.seTax)} />
              <Row label="Federal income tax" value={money(view.breakdown.federalIncomeTax)} />
              <Row label={stateLabel} value={money(view.breakdown.stateIncomeTax)} />
              {view.breakdown.cushion > 0 && <Row label={`Cushion (rate rounded up to ${pct}%)`} value={money(view.breakdown.cushion)} />}
              <Row label="Set aside" value={money(view.setAside)} strong />
            </div>
          </details>

          {view.qbiSkipped && (
            <p style={{ margin: '12px 0 0', fontSize: '14px', color: '#fde68a' }}>
              Above {money(view.qbiThreshold).replace('.00', '')}? Talk to a CPA about your QBI deduction.
            </p>
          )}

          <p style={{ margin: '16px 0 0', fontSize: '16px' }}>
            Next IRS estimated payment due: <strong>{longDate(dueIso)}</strong>
          </p>
          {view.setAside > 0 && (
            <p style={{ margin: '12px 0 0', padding: '12px 14px', background: 'rgba(249,115,22,0.18)', borderRadius: radius.md, fontSize: '17px', fontWeight: 700 }}>
              💡 Move {money(view.setAside)} into a separate savings account today, before you spend a dime.
            </p>
          )}
          <p style={{ margin: '16px 0 0', fontSize: '13px', color: '#cbd5e1', lineHeight: 1.5 }}>{disclaimer}</p>
        </Card>

        <Waitlist filingStatus={filingStatus} stateKind={stateKind} annualNet={view.annualNet} />

        <section aria-labelledby="writeoffs" style={{ margin: '32px 0' }}>
          <h2 id="writeoffs" style={{ fontSize: '24px', margin: '0 0 12px' }}>Common write-offs for the trades</h2>
          <p style={{ margin: '0 0 12px', color: '#334155', lineHeight: 1.55 }}>Every legit business expense lowers your profit, and that lowers the tax you owe on it. Keep receipts for all of these.</p>
          {writeOffs.map(w => (
            <div key={w.title} style={{ padding: '12px 0', borderTop: `1px solid ${colors.border}` }}>
              <h3 style={{ margin: '0 0 4px', fontSize: '18px' }}>{w.title}</h3>
              <p style={{ margin: 0, color: '#334155', lineHeight: 1.55 }}>{w.body}</p>
            </div>
          ))}
        </section>

        <section aria-labelledby="faq" style={{ margin: '32px 0' }}>
          <h2 id="faq" style={{ fontSize: '24px', margin: '0 0 12px' }}>Frequently asked questions</h2>
          {faq.map(f => (
            <details key={f.q} style={{ borderTop: `1px solid ${colors.border}`, padding: '4px 0' }}>
              <summary><h3 style={{ margin: 0, fontSize: '18px' }}>{f.q}</h3></summary>
              <p style={{ margin: '0 0 12px', color: '#334155', lineHeight: 1.6 }}>{f.a}</p>
            </details>
          ))}
        </section>
      </main>

      <footer style={{ borderTop: `1px solid ${colors.border}`, padding: '20px 16px 32px' }}>
        <div style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '14px' }}>
          <a href="/" style={{ fontWeight: 600 }}>BuildPro+ for contractors</a>
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
        </div>
      </footer>
    </div>
  )
}
