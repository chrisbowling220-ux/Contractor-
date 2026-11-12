import { describe, expect, it } from 'vitest'
import type { AIQuote, ChangeOrder, Estimate, Invoice } from '../data/types'
import { toCustomerView } from './customerView'
import { buildFallbackQuote } from './fallbackQuote'
import {
  balanceOf, buildInvoiceLineItems, changeOrderBaseTotal, collectedBetween, collectedEvents, contractTotal,
  estimateInvoiceLines, isOverdue, localDateStr, nextInvoiceNumberFrom, paidOnInvoice, recordPayment,
  removePayment, sumLines,
} from './invoiceMath'

// A Quick Quote exactly as it is saved: raw costs, with the markup separate.
function quote(markupPercent = 20): AIQuote {
  const material_list = [
    { name: 'LVP flooring', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 3.29, line_total: 832.37 },
    { name: 'Underlayment', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 0.47, line_total: 118.91 },
    { name: 'Transition strips', base_quantity: 3, waste_percent: 0, quantity_with_waste: 3, quantity_math: '', unit: 'each', unit_price: 18.97, line_total: 56.91 },
  ]
  const materials_subtotal = 1008.19
  const labor_total = 1040
  const rentals_subtotal = 45
  const raw_cost = 2093.19
  const markup_dollars = +(raw_cost * markupPercent / 100).toFixed(2)
  return {
    customer_summary: '', work_scope: '', material_list,
    labor: { estimated_hours: 16, breakdown: '', hourly_rate: 65, labor_total },
    price_breakdown: { labor_subtotal: labor_total, materials_subtotal, rentals_subtotal, raw_cost },
    profit_markup: { markup_percent: markupPercent, markup_dollars, rationale: '' },
    final_customer_quote: +(raw_cost + markup_dollars).toFixed(2),
    contractor_notes: '',
  }
}
function estimate(extra: Partial<Estimate> = {}): Estimate {
  const aiQuote = quote()
  return {
    id: 'e1', customerName: 'Pat Doe', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote', description: '',
    rateType: 'hourly', laborTotal: 1040, materials: [], materialsTotal: 1008.19, rentals: [], rentalsTotal: 45,
    jobLocationZip: '27573', jobLocationRegion: '', regionMultiplier: 1, total: aiQuote.final_customer_quote,
    scopeOfWork: '', aiQuote, status: 'approved', createdAt: '2026-11-01T12:00:00.000Z', ...extra,
  }
}
function co(delta: number, status: ChangeOrder['status'], id = 'c' + delta): ChangeOrder {
  return { id, projectId: 'p1', customerName: 'Pat Doe', description: 'Add closet', reason: 'customer_requested', lineItems: [], originalTotal: 0, delta, newTotal: 0, status, createdAt: '' }
}
function invoice(extra: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1', projectId: 'p1', customerName: 'Pat Doe', jobTypeName: 'Flooring', invoiceNumber: 'INV-2026-0001',
    introNote: '', paymentTerms: '', lineItems: [], subtotal: 2511.83, amountPaid: 0, amountDue: 2511.83,
    status: 'sent', dueDate: '2026-11-24T12:00:00.000Z', createdAt: '2026-11-10T12:00:00.000Z', ...extra,
  }
}

describe('markup folded into customer prices', () => {
  it('keeps the grand total and makes the breakdown add up to it exactly', () => {
    for (const pct of [0, 12.5, 20, 33, 35]) {
      const q = quote(pct)
      const v = toCustomerView(q)
      const sum = +(v.material_list.reduce((s, m) => s + m.line_total, 0) + v.labor.labor_total + v.price_breakdown.rentals_subtotal).toFixed(2)
      expect(sum).toBe(q.final_customer_quote)
      expect(v.final_customer_quote).toBe(q.final_customer_quote)
      expect(v.price_breakdown.raw_cost).toBe(q.final_customer_quote)
      expect(v.profit_markup.markup_dollars).toBe(0)
    }
  })
  it('puts the markup on labor when there are no materials', () => {
    const q = quote(20)
    const bare: AIQuote = { ...q, material_list: [], price_breakdown: { ...q.price_breakdown, materials_subtotal: 0, raw_cost: 1085 }, profit_markup: { markup_percent: 20, markup_dollars: 217, rationale: '' }, final_customer_quote: 1302 }
    const v = toCustomerView(bare)
    expect(v.labor.labor_total).toBe(1257)
    expect(+(v.labor.labor_total + v.price_breakdown.rentals_subtotal).toFixed(2)).toBe(1302)
    // ...and into the rate, so "hours × rate" on the invoice line does not
    // give the markup away by subtraction.
    expect(Math.abs(v.labor.estimated_hours * v.labor.hourly_rate - v.labor.labor_total)).toBeLessThanOrEqual(v.labor.estimated_hours * 0.005 + 1e-9)
    expect(v.labor.hourly_rate).toBeGreaterThan(q.labor.hourly_rate)
  })
  it('leaves the rate alone when the labor has no hours (flat price)', () => {
    const q = quote(20)
    const flat: AIQuote = { ...q, material_list: [], labor: { ...q.labor, estimated_hours: 0 }, price_breakdown: { ...q.price_breakdown, materials_subtotal: 0 }, profit_markup: { markup_percent: 20, markup_dollars: 100, rationale: '' } }
    const v = toCustomerView(flat)
    expect(v.labor.hourly_rate).toBe(q.labor.hourly_rate)
    expect(v.labor.labor_total).toBe(+(q.labor.labor_total + 100).toFixed(2))
  })
  it('is a no-op once the markup is already folded in', () => {
    const once = toCustomerView(quote())
    expect(toCustomerView(once)).toEqual(once)
  })
})

describe('invoice line items', () => {
  it('bills the full signed estimate, markup included', () => {
    const e = estimate()
    const lines = estimateInvoiceLines(e, 'Flooring')
    expect(sumLines(lines)).toBe(e.total)                 // 2511.83, not the 2093.19 raw cost
    expect(sumLines(lines)).toBeGreaterThan(e.aiQuote!.price_breakdown.raw_cost)
    expect(lines.some(l => /markup/i.test(l.name))).toBe(false)   // never shown to the customer
    expect(lines.map(l => l.name)).toContain('Rental equipment')
    expect(lines.find(l => l.name.startsWith('Labor'))?.lineTotal).toBe(1040)
  })
  it('gives the same total for a quote the contractor already edited', () => {
    const e = estimate()
    const edited = estimate({ aiQuote: toCustomerView(e.aiQuote!) })
    expect(sumLines(estimateInvoiceLines(edited, 'Flooring'))).toBe(e.total)
  })
  it('uses one roll-up line when there is no itemised quote', () => {
    const lines = estimateInvoiceLines(estimate({ aiQuote: undefined, total: 1800 }), 'Deck repair')
    expect(lines).toEqual([{ name: 'Deck repair (per estimate)', quantity: 1, unitPrice: 1800, lineTotal: 1800 }])
  })
  it('shows a difference from the agreed total as its own line rather than dropping it', () => {
    const lines = estimateInvoiceLines(estimate({ total: 2600 }), 'Flooring')
    expect(sumLines(lines)).toBe(2600)
    expect(lines.at(-1)).toMatchObject({ name: 'Adjustment to agreed estimate total', lineTotal: 88.17 })
  })
  it('adds approved change orders only, credits included', () => {
    const e = estimate()
    const cos = [co(350, 'approved'), co(-120, 'approved'), co(900, 'pending'), co(75, 'declined')]
    const lines = buildInvoiceLineItems([e], cos, 'Flooring')
    expect(sumLines(lines)).toBe(+(e.total + 350 - 120).toFixed(2))
    expect(lines.filter(l => l.name.startsWith('Change Order')).length).toBe(2)
  })
  it('bills every live estimate on the job and skips declined ones', () => {
    const a = estimate({ id: 'a' }), b = estimate({ id: 'b', aiQuote: undefined, total: 500, status: 'pending' })
    const declined = estimate({ id: 'd', status: 'declined', total: 9999 })
    const lines = buildInvoiceLineItems([a, b, declined], [], 'Flooring')
    expect(sumLines(lines)).toBe(+(a.total + 500).toFixed(2))
    expect(sumLines(lines)).toBe(contractTotal([a, b, declined], []))
  })
  it('the fallback (offline) quote invoices to its own total', () => {
    const q = buildFallbackQuote({
      customerName: 'Pat', jobTypeName: 'Paint', description: '', jobLocationZip: '27573',
      materials: [{ materialId: 'm', name: 'Interior paint', quantity: 7, unit: 'gal', unitPrice: 38.98 }],
      rentals: [{ rentalId: 'r', name: 'Sprayer', days: 2, dailyRate: 89, deposit: 0 }],
      hourlyRate: 65, estimatedHours: 12, markupPercent: 20, rateType: 'hourly',
    })
    expect(q.material_list[0].quantity_with_waste).toBe(8)                       // 7 gal + 5% waste, rounded up
    expect(q.price_breakdown.raw_cost).toBe(+(8 * 38.98 + 178 + 780).toFixed(2))
    expect(q.final_customer_quote).toBe(+(q.price_breakdown.raw_cost * 1.2).toFixed(2))
    expect(sumLines(estimateInvoiceLines(estimate({ aiQuote: q, total: q.final_customer_quote }), 'Paint'))).toBe(q.final_customer_quote)
  })
})

describe('contract total and change orders', () => {
  it('a second change order starts from the contract including the first', () => {
    const e = estimate({ total: 4000, aiQuote: undefined })
    const first = co(500, 'approved', 'first')
    expect(changeOrderBaseTotal([e], [], undefined)).toBe(4000)
    expect(changeOrderBaseTotal([e], [first], undefined)).toBe(4500)
    expect(changeOrderBaseTotal([e], [first], 'first')).toBe(4000)   // editing the first one
  })
  it('a revised estimate is billed once, at the version the customer signed', () => {
    const v1 = estimate({ id: 'v1', total: 4000, aiQuote: undefined, status: 'approved', supersededBy: 'v2' })
    const v2 = (status: Estimate['status']) => estimate({ id: 'v2', total: 4600, aiQuote: undefined, status, revision: 2, previousVersionId: 'v1', originalEstimateId: 'v1' })
    expect(contractTotal([v1, v2('pending')], [])).toBe(4000)    // revision not signed yet
    expect(contractTotal([v1, v2('declined')], [])).toBe(4000)   // customer kept the original
    expect(contractTotal([v1, v2('approved')], [])).toBe(4600)   // revision signed, replaces v1
    expect(sumLines(buildInvoiceLineItems([v1, v2('approved')], [], 'Paint'))).toBe(4600)
  })
})

describe('recording payments', () => {
  const now = new Date('2026-11-12T15:00:00.000Z')

  it('a part payment lowers the balance and keeps the invoice open', () => {
    const u = recordPayment(invoice(), { amount: 1000, method: 'check', date: '2026-11-12', note: 'Check #1042' }, now, 'p1')
    expect(u).toEqual({
      payments: [{ id: 'p1', amount: 1000, method: 'check', date: '2026-11-12', note: 'Check #1042', recordedAt: now.toISOString(), source: 'manual' }],
      amountPaid: 1000, amountDue: 1511.83, status: 'sent',
    })
  })
  it('paying the rest marks it paid and stamps the retention clock', () => {
    const first = recordPayment(invoice(), { amount: 1000, method: 'check', date: '2026-11-12' }, now, 'p1')
    const second = recordPayment({ ...invoice(), ...first }, { amount: 1511.83, method: 'cash', date: '2026-11-20' }, now, 'p2')
    expect(second.amountDue).toBe(0)
    expect(second.amountPaid).toBe(2511.83)
    expect(second.status).toBe('paid')
    expect(second.paidAtMs).toBe(now.getTime())
    expect(second.payments).toHaveLength(2)
  })
  it('counts a credited deposit: only the balance can be paid', () => {
    const inv = invoice({ amountPaid: 500, amountDue: 2011.83 })
    expect(() => recordPayment(inv, { amount: 2500, method: 'cash', date: '2026-11-12' }, now)).toThrow(/more than the \$2011\.83/)
    expect(recordPayment(inv, { amount: 2011.83, method: 'cash', date: '2026-11-12' }, now).status).toBe('paid')
  })
  it('rejects zero, negative, junk and already-paid', () => {
    for (const amount of [0, -5, NaN]) expect(() => recordPayment(invoice(), { amount, method: 'cash', date: '2026-11-12' }, now)).toThrow(/greater than zero/)
    expect(() => recordPayment(invoice(), { amount: 10, method: 'cash', date: 'yesterday' }, now)).toThrow(/date/)
    expect(() => recordPayment(invoice({ status: 'paid', amountDue: 0 }), { amount: 10, method: 'cash', date: '2026-11-12' }, now)).toThrow(/already paid/)
  })
  it('has no floating-point drift across many small payments', () => {
    let inv = invoice({ subtotal: 1, amountDue: 1 })
    for (let i = 0; i < 10; i++) inv = { ...inv, ...recordPayment(inv, { amount: 0.1, method: 'cash', date: '2026-11-12' }, now, 'p' + i) }
    expect(inv.amountDue).toBe(0)
    expect(inv.status).toBe('paid')
  })
  it('removing a payment re-opens the invoice', () => {
    const paid = { ...invoice(), ...recordPayment(invoice(), { amount: 2511.83, method: 'cash', date: '2026-11-12' }, now, 'p1') }
    const u = removePayment(paid, 'p1')
    expect(u).toMatchObject({ payments: [], amountPaid: 0, amountDue: 2511.83, status: 'sent', reopened: true })
  })
  it('a card payment recorded by Stripe cannot be removed by hand', () => {
    const inv = invoice({ status: 'paid', amountPaid: 2511.83, amountDue: 0, payments: [{ id: 's1', amount: 2511.83, method: 'card', date: '2026-11-12', recordedAt: '', source: 'stripe' }] })
    expect(() => removePayment(inv, 's1')).toThrow(/Stripe/)
    expect(() => removePayment(inv, 'nope')).toThrow(/no longer/)
  })
  it('balance never goes negative', () => {
    expect(balanceOf(100, 250)).toBe(0)
    expect(balanceOf(100.1, 100)).toBe(0.1)
  })
})

describe('money actually collected (dashboard revenue)', () => {
  const nov1 = new Date('2026-11-01T00:00:00').getTime()
  const dec1 = new Date('2026-12-01T00:00:00').getTime()

  it('does not count a deposit twice when the final invoice credits it', () => {
    const deposit = invoice({ id: 'dep', isDeposit: true, subtotal: 1000, amountPaid: 0, amountDue: 0, status: 'paid', paidAt: '2026-11-03T15:00:00.000Z' })
    // Final invoice for the whole $4,200 job, $1,000 deposit credited, rest paid by card (old webhook: no payment entry).
    const final = invoice({ id: 'fin', subtotal: 4200, amountPaid: 1000, amountDue: 0, status: 'paid', paidAt: '2026-11-20T15:00:00.000Z' })
    expect(collectedBetween([deposit, final], nov1, dec1)).toBe(4200)   // was 5200 when summing subtotals
  })
  it('counts part payments in the month they arrived, before the invoice is paid off', () => {
    const inv = invoice({ subtotal: 3000, amountPaid: 1200, amountDue: 1800, payments: [
      { id: 'a', amount: 700, method: 'cash', date: '2026-10-28', recordedAt: '', source: 'manual' },
      { id: 'b', amount: 500, method: 'check', date: '2026-11-05', recordedAt: '', source: 'manual' },
    ] })
    expect(collectedBetween([inv], nov1, dec1)).toBe(500)
    expect(collectedEvents(inv)).toHaveLength(2)
  })
  it('a fully itemised paid invoice is not counted again on paidAt', () => {
    const inv = invoice({ subtotal: 800, amountPaid: 800, amountDue: 0, status: 'paid', paidAt: '2026-11-09T12:00:00.000Z', payments: [
      { id: 'a', amount: 800, method: 'card', date: '2026-11-09', recordedAt: '', source: 'stripe' },
    ] })
    expect(collectedBetween([inv], nov1, dec1)).toBe(800)
  })
  it('unpaid invoices with no payments count for nothing', () => {
    expect(collectedBetween([invoice()], 0)).toBe(0)
  })
  it('labels and overdue', () => {
    expect(paidOnInvoice(invoice({ status: 'paid', amountDue: 0 }))).toBe(2511.83)
    expect(paidOnInvoice(invoice({ amountPaid: 300 }))).toBe(300)
    const t = new Date('2026-12-01T00:00:00.000Z').getTime()
    expect(isOverdue(invoice(), t)).toBe(true)
    expect(isOverdue(invoice({ status: 'paid', amountDue: 0 }), t)).toBe(false)
    expect(isOverdue(invoice(), new Date('2026-11-11T00:00:00.000Z').getTime())).toBe(false)
  })
})

describe('invoice numbers', () => {
  it('goes one past the highest number used this year, even after deletions', () => {
    expect(nextInvoiceNumberFrom([], 2026)).toBe('INV-2026-0001')
    expect(nextInvoiceNumberFrom(['INV-2026-0001', 'INV-2026-0003'], 2026)).toBe('INV-2026-0004')   // 0002 was deleted
    expect(nextInvoiceNumberFrom(['INV-2025-0041', undefined, 'garbage'], 2026)).toBe('INV-2026-0001')
    expect(nextInvoiceNumberFrom(['INV-2026-9999'], 2026)).toBe('INV-2026-10000')
  })
})

describe('local dates', () => {
  it('uses the device day, not the UTC day', () => {
    const lateEvening = new Date(2026, 10, 10, 21, 30)   // Nov 10, 9:30pm local
    expect(localDateStr(lateEvening)).toBe('2026-11-10')
    expect(localDateStr(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05')
  })
})
