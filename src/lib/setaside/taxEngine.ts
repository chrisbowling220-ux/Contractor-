// Safe-to-Spend tax engine. Pure functions only — no UI, no I/O.
//
// Answers "how much of this money is the government's?" for a 1099 earner by
// working out the tax the self-employment income ADDS on top of whatever else
// the household earns (tax with the SE income minus tax without it). Nothing is
// rounded until the very end, so totals line up with a hand calculation.
import type { Bracket, FilingStatus, StateOption, TaxYearConfig } from './types'

export interface AnnualInput {
  /** Business profit for the year: gross 1099 income minus business expenses. */
  net: number
  filingStatus: FilingStatus
  state: StateOption
  /** W-2 wages / spouse's wages for the year. */
  otherIncome: number
  config: TaxYearConfig
}

export interface AnnualResult {
  net: number
  seBase: number
  socialSecurity: number
  medicare: number
  addlMedicare: number
  /** Social Security + Medicare + Additional Medicare. */
  seTax: number
  federalIncomeTax: number
  stateIncomeTax: number
  /** Exact tax the SE income adds, before rounding the rate up. */
  totalTax: number
  /** totalTax / net, unrounded (0 when there's no profit). */
  exactRate: number
  /** exactRate rounded UP to the next whole percent — the rate we tell people to save. */
  rate: number
  /** Set-aside at the rounded rate: rate × net. */
  setAside: number
  /** True when taxable income is past the QBI threshold and we gave no QBI deduction. */
  qbiSkipped: boolean
  qbiThreshold: number
}

export interface PaymentInput extends Omit<AnnualInput, 'net'> {
  payment: number
  materials: number
  /** "About how much will you clear this year after expenses?" — sets the rate. */
  annualNet: number
}

export interface PaymentResult {
  annual: AnnualResult
  rate: number
  /** Money that just pays back materials/expenses — not spending money. */
  coveringCosts: number
  profit: number
  setAside: number
  yoursToSpend: number
  /** The set-aside split by tax type, scaled from the annual picture. */
  breakdown: { seTax: number; federalIncomeTax: number; stateIncomeTax: number; cushion: number }
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const clean = (n: number): number => (Number.isFinite(n) ? n : 0)

export function bracketTax(taxable: number, brackets: Bracket[]): number {
  let tax = 0
  let floor = 0
  for (const b of brackets) {
    if (taxable <= floor) break
    tax += (Math.min(taxable, b.upTo) - floor) * b.rate
    floor = b.upTo
  }
  return tax
}

/** Round a rate up to the next whole percent, ignoring float noise like 0.23000000000000004. */
export function roundRateUp(rate: number): number {
  if (rate <= 0) return 0
  return Math.ceil(rate * 100 - 1e-9) / 100
}

interface Side {
  agi: number
  preQbi: number
  federal: number
  qbiSkipped: boolean
}

// One side of the with/without comparison. `businessNet` is 0 on the "without" side.
function federalSide(
  otherIncome: number,
  businessNet: number,
  halfSe: number,
  status: FilingStatus,
  config: TaxYearConfig,
): Side {
  const agi = otherIncome + businessNet - halfSe
  const preQbi = Math.max(0, agi - config.standardDeduction[status])
  let qbi = 0
  let qbiSkipped = false
  if (preQbi <= config.qbiThreshold[status]) {
    qbi = Math.max(0, Math.min(config.qbiRate * (businessNet - halfSe), config.qbiRate * preQbi))
  } else if (businessNet > 0) {
    qbiSkipped = true // conservative: no QBI above the threshold
  }
  const taxable = Math.max(0, preQbi - qbi)
  return { agi, preQbi, federal: bracketTax(taxable, config.brackets[status]), qbiSkipped }
}

function ncTax(agi: number, status: FilingStatus, config: TaxYearConfig): number {
  return Math.max(0, agi - config.nc.standardDeduction[status]) * config.nc.rate
}

export function computeAnnual(input: AnnualInput): AnnualResult {
  const { filingStatus: status, state, config } = input
  const net = clean(input.net)
  const otherIncome = Math.max(0, clean(input.otherIncome))
  const qbiThreshold = config.qbiThreshold[status]

  const empty: AnnualResult = {
    net, seBase: 0, socialSecurity: 0, medicare: 0, addlMedicare: 0, seTax: 0,
    federalIncomeTax: 0, stateIncomeTax: 0, totalTax: 0, exactRate: 0, rate: 0,
    setAside: 0, qbiSkipped: false, qbiThreshold,
  }
  if (net <= 0) return empty

  // 1–5: self-employment tax
  let seBase = net * config.seEarningsFactor
  if (seBase < config.seMinimum) seBase = 0
  const ssRoom = Math.max(0, config.ssWageBase - otherIncome)
  const socialSecurity = config.ssRate * Math.min(seBase, ssRoom)
  const medicare = config.medicareRate * seBase
  const addlMedicare = config.addlMedicareRate *
    Math.max(0, seBase + otherIncome - config.addlMedicareThreshold[status])
  const halfSe = (socialSecurity + medicare) / 2

  // 6: federal income tax the SE income adds
  const withSe = federalSide(otherIncome, net, halfSe, status, config)
  const withoutSe = federalSide(otherIncome, 0, 0, status, config)
  const federalIncomeTax = Math.max(0, withSe.federal - withoutSe.federal)

  // 7: state income tax the SE income adds
  let stateIncomeTax = 0
  if (state.kind === 'nc') {
    stateIncomeTax = Math.max(0, ncTax(withSe.agi, status, config) - ncTax(withoutSe.agi, status, config))
  } else if (state.kind === 'other') {
    stateIncomeTax = Math.max(0, clean(state.ratePct)) / 100 * net
  }

  // 8–9: total and rate
  const seTax = socialSecurity + medicare + addlMedicare
  const totalTax = seTax + federalIncomeTax + stateIncomeTax
  const exactRate = totalTax / net
  const rate = roundRateUp(exactRate)

  return {
    net,
    seBase: cents(seBase),
    socialSecurity: cents(socialSecurity),
    medicare: cents(medicare),
    addlMedicare: cents(addlMedicare),
    seTax: cents(seTax),
    federalIncomeTax: cents(federalIncomeTax),
    stateIncomeTax: cents(stateIncomeTax),
    totalTax: cents(totalTax),
    exactRate,
    rate,
    setAside: cents(rate * net),
    qbiSkipped: withSe.qbiSkipped,
    qbiThreshold,
  }
}

export function computePayment(input: PaymentInput): PaymentResult {
  const annual = computeAnnual({ ...input, net: input.annualNet })
  const payment = Math.max(0, clean(input.payment))
  const materials = Math.max(0, clean(input.materials))
  const coveringCosts = Math.min(materials, payment)
  const profit = Math.max(0, payment - materials)
  const setAside = cents(annual.rate * profit)
  const yoursToSpend = cents(Math.max(0, payment - materials - setAside))

  // Split the set-aside the same way the annual tax splits; whatever's left
  // over is the cushion from rounding the rate up.
  const share = annual.net > 0 ? profit / annual.net : 0
  const seTax = cents(annual.seTax * share)
  const federalIncomeTax = cents(annual.federalIncomeTax * share)
  const stateIncomeTax = cents(annual.stateIncomeTax * share)
  const cushion = cents(Math.max(0, setAside - seTax - federalIncomeTax - stateIncomeTax))

  return {
    annual, rate: annual.rate, coveringCosts, profit, setAside, yoursToSpend,
    breakdown: { seTax, federalIncomeTax, stateIncomeTax, cushion },
  }
}

// ── Due dates ────────────────────────────────────────────────────────────

function iso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Standard quarterly dates for a tax year with weekend rollover to Monday.
// Only used for years we don't have an official config for yet.
export function standardDueDates(year: number): string[] {
  const raw: [number, number, number][] = [[year, 3, 15], [year, 5, 15], [year, 8, 15], [year + 1, 0, 15]]
  return raw.map(([y, m, d]) => {
    const date = new Date(y, m, d)
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1)
    return iso(date)
  })
}

/** First estimated-tax due date on or after `today` (YYYY-MM-DD). */
export function nextDueDate(today: Date, configs: TaxYearConfig[]): string {
  const todayIso = iso(today)
  const known = new Set(configs.map(c => c.year))
  const dates = [
    ...configs.flatMap(c => c.estimatedDueDates),
    ...[today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]
      .filter(y => !known.has(y))
      .flatMap(standardDueDates),
  ].sort()
  return dates.find(d => d >= todayIso) ?? standardDueDates(today.getFullYear() + 1)[0]
}

// ── Waitlist bucket ──────────────────────────────────────────────────────

const BUCKETS: [number, string][] = [
  [10_000, '0-10k'], [25_000, '10-25k'], [50_000, '25-50k'], [75_000, '50-75k'],
  [100_000, '75-100k'], [150_000, '100-150k'], [250_000, '150-250k'],
]

/** A coarse range for analytics — we never store someone's exact number. */
export function netBucket(net: number): string {
  if (!(net > 0)) return '0'
  for (const [limit, label] of BUCKETS) if (net < limit) return label
  return '250k+'
}
