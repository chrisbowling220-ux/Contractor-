import { describe, expect, it } from 'vitest'
import tax2026 from './taxYears/2026'
import { computeAnnual, computePayment, netBucket, nextDueDate, roundRateUp, standardDueDates } from './taxEngine'
import type { FilingStatus, StateOption } from './types'

const NC: StateOption = { kind: 'nc' }
const annual = (net: number, opts: { status?: FilingStatus; state?: StateOption; other?: number } = {}) =>
  computeAnnual({
    net,
    filingStatus: opts.status ?? 'single',
    state: opts.state ?? NC,
    otherIncome: opts.other ?? 0,
    config: tax2026,
  })

describe('main case: single, NC, $50,000 net, no other income', () => {
  const r = annual(50_000)
  it('self-employment tax', () => expect(r.seTax).toBe(7064.78))
  it('federal income tax', () => expect(r.federalIncomeTax).toBe(2667.29))
  it('NC income tax', () => expect(r.stateIncomeTax).toBe(1345.33))
  it('total', () => expect(r.totalTax).toBe(11077.40))
  it('exact rate 22.15%, rounded up to 23%', () => {
    expect(r.exactRate * 100).toBeCloseTo(22.15, 2)
    expect(r.rate).toBe(0.23)
    expect(r.setAside).toBe(11_500)
  })
  it('gets the QBI deduction (well under the threshold)', () => expect(r.qbiSkipped).toBe(false))
})

describe('no profit', () => {
  it('$0 net owes nothing', () => {
    const r = annual(0)
    expect(r.totalTax).toBe(0)
    expect(r.rate).toBe(0)
    expect(r.setAside).toBe(0)
  })
  it('negative net owes nothing', () => {
    const r = annual(-5_000, { other: 40_000 })
    expect(r.totalTax).toBe(0)
    expect(r.rate).toBe(0)
  })
})

describe('under the $400 SE threshold', () => {
  it('no SE tax when 92.35% of net is under $400', () => {
    const r = annual(400) // 400 × 0.9235 = 369.40
    expect(r.seBase).toBe(0)
    expect(r.seTax).toBe(0)
    expect(r.totalTax).toBe(0)
  })
  it('SE tax kicks in once 92.35% of net reaches $400', () => {
    expect(annual(434).seTax).toBeGreaterThan(0) // 434 × 0.9235 = 400.80
  })
})

describe('over the Social Security wage base', () => {
  const r = annual(250_000) // seBase 230,875
  it('caps Social Security at 12.4% of $184,500', () => expect(r.socialSecurity).toBe(22_878))
  it('keeps Medicare on everything', () => expect(r.medicare).toBe(6695.38))
  it('adds 0.9% Additional Medicare over $200,000', () => expect(r.addlMedicare).toBe(277.88))
  it('drops QBI above the threshold and flags it', () => {
    expect(r.qbiSkipped).toBe(true)
    expect(r.qbiThreshold).toBe(201_750)
    // preQBI 219,113.3125 → 41,024 + 32% × (219,113.3125 − 201,775)
    expect(r.federalIncomeTax).toBe(46572.26)
  })
})

describe('W-2 income and the wage base', () => {
  it('W-2 wages use up Social Security room first', () => {
    const r = annual(50_000, { other: 150_000 })
    expect(r.socialSecurity).toBe(4278) // 12.4% × (184,500 − 150,000)
    expect(r.medicare).toBe(1339.08)
    expect(r.addlMedicare).toBe(0) // 46,175 + 150,000 < 200,000
  })
  it('W-2 wages over the wage base leave no Social Security', () => {
    const r = annual(50_000, { other: 190_000 })
    expect(r.socialSecurity).toBe(0)
    expect(r.addlMedicare).toBe(325.58) // 0.9% × (46,175 + 190,000 − 200,000)
  })
  it('W-2 income pushes SE profit into higher brackets', () => {
    expect(annual(50_000, { other: 60_000 }).federalIncomeTax).toBeGreaterThan(annual(50_000).federalIncomeTax)
  })
})

describe('other filing statuses', () => {
  it('married filing jointly', () => {
    const r = annual(50_000, { status: 'mfj' })
    expect(r.seTax).toBe(7064.78)
    expect(r.federalIncomeTax).toBe(1141.41)
    expect(r.stateIncomeTax).toBe(836.61)
    expect(r.totalTax).toBe(9042.79)
    expect(r.rate).toBe(0.19)
  })
  it('head of household', () => {
    const r = annual(50_000, { status: 'hoh' })
    expect(r.federalIncomeTax).toBe(1788.49)
    expect(r.stateIncomeTax).toBe(1090.97)
    expect(r.totalTax).toBe(9944.24)
    expect(r.rate).toBe(0.20)
  })
  it('MFJ Additional Medicare threshold is $250,000', () => {
    expect(annual(250_000, { status: 'mfj' }).addlMedicare).toBe(0) // 230,875 < 250,000
  })
})

describe('state options', () => {
  it('"Other %" is that percent of net', () => {
    const r = annual(50_000, { state: { kind: 'other', ratePct: 5 } })
    expect(r.stateIncomeTax).toBe(2500)
    expect(r.totalTax).toBe(12232.07)
    expect(r.rate).toBe(0.25)
  })
  it('no state income tax', () => {
    const r = annual(50_000, { state: { kind: 'none' } })
    expect(r.stateIncomeTax).toBe(0)
    expect(r.totalTax).toBe(9732.07)
    expect(r.rate).toBe(0.20)
  })
})

describe('This Payment', () => {
  const p = computePayment({
    payment: 2000, materials: 500, annualNet: 50_000,
    filingStatus: 'single', state: NC, otherIncome: 0, config: tax2026,
  })
  it('$2,000 payment, $500 materials, $50k year → $345 set aside, $1,155 yours', () => {
    expect(p.rate).toBe(0.23)
    expect(p.coveringCosts).toBe(500)
    expect(p.setAside).toBe(345)
    expect(p.yoursToSpend).toBe(1155)
  })
  it('breakdown adds back up to the set-aside', () => {
    const b = p.breakdown
    expect(b.seTax + b.federalIncomeTax + b.stateIncomeTax + b.cushion).toBeCloseTo(345, 2)
  })
  it('materials bigger than the payment never go negative', () => {
    const q = computePayment({
      payment: 300, materials: 500, annualNet: 50_000,
      filingStatus: 'single', state: NC, otherIncome: 0, config: tax2026,
    })
    expect(q.setAside).toBe(0)
    expect(q.yoursToSpend).toBe(0)
    expect(q.coveringCosts).toBe(300)
  })
})

describe('helpers', () => {
  it('rounds rates up without float noise', () => {
    expect(roundRateUp(0.23)).toBe(0.23)
    expect(roundRateUp(0.2215)).toBe(0.23)
    expect(roundRateUp(0.1 + 0.13)).toBe(0.23)
  })
  it('next due date is the first one on or after today', () => {
    expect(nextDueDate(new Date(2026, 9, 19), [tax2026])).toBe('2027-01-15')
    expect(nextDueDate(new Date(2026, 3, 15), [tax2026])).toBe('2026-04-15')
    expect(nextDueDate(new Date(2026, 3, 16), [tax2026])).toBe('2026-06-15')
    // Past the last 2026 date with no 2027 config: standard 2027 dates.
    expect(nextDueDate(new Date(2027, 1, 1), [tax2026])).toBe('2027-04-15')
  })
  it('standard dates roll weekends to Monday', () => {
    expect(standardDueDates(2027)[3]).toBe('2028-01-17') // Jan 15 2028 is a Saturday
  })
  it('buckets net income instead of storing it', () => {
    expect(netBucket(0)).toBe('0')
    expect(netBucket(40_000)).toBe('25-50k')
    expect(netBucket(50_000)).toBe('50-75k')
    expect(netBucket(300_000)).toBe('250k+')
  })
})
