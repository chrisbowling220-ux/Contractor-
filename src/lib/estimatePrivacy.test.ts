import { describe, expect, it } from 'vitest'
import type { AIQuote } from '../data/types'
import { toCustomerView } from './customerView'
import {
  customerSafeEstimate, customerSafeQuote, customerVisibleContent, isCustomerSafeQuote, splitEstimateForSharing,
} from './estimatePrivacy'

const quote = (extra: Partial<AIQuote> = {}): AIQuote => ({
  customer_summary: 'Replace the back deck boards',
  work_scope: 'Remove and replace 240 sq ft of decking',
  material_list: [
    { name: 'Board', base_quantity: 40, waste_percent: 10, quantity_with_waste: 44, quantity_math: '', unit: 'each', unit_price: 10, line_total: 440 },
    { name: 'Screws', base_quantity: 2, waste_percent: 0, quantity_with_waste: 2, quantity_math: '', unit: 'box', unit_price: 30, line_total: 60 },
  ],
  labor: { estimated_hours: 10, breakdown: 'tear-out and install', hourly_rate: 60, labor_total: 600 },
  price_breakdown: { labor_subtotal: 600, materials_subtotal: 500, rentals_subtotal: 0, raw_cost: 1100 },
  profit_markup: { markup_percent: 20, markup_dollars: 220, rationale: 'tight access' },
  final_customer_quote: 1320,
  contractor_notes: 'Verify joists',
  ...extra,
})

const quickQuote = (extra: Record<string, unknown> = {}) => ({
  id: 'e1', createdBy: 'u1', customerName: 'Pat', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote',
  description: 'my walkthrough', laborTotal: 600, materialsTotal: 500, rentalsTotal: 0, total: 1320,
  aiQuote: quote(), status: 'pending', ...extra,
})

describe('customerSafeQuote', () => {
  it('folds the markup into the prices, keeps the total and empties the private parts', () => {
    const q = customerSafeQuote(quote())
    expect(q.final_customer_quote).toBe(1320)
    expect(q.contractor_notes).toBe('')
    expect(q.profit_markup).toEqual({ markup_percent: 0, markup_dollars: 0, rationale: '' })
    const lines = +q.material_list.reduce((s, m) => s + m.line_total, 0).toFixed(2)
    expect(+(lines + q.labor.labor_total).toFixed(2)).toBe(1320)
    expect(isCustomerSafeQuote(q)).toBe(true)
  })
  it('is what the customer page already showed, and does nothing to a clean quote', () => {
    const raw = quote()
    const safe = customerSafeQuote(raw)
    expect({ ...toCustomerView(raw), contractor_notes: '' }).toEqual({ ...toCustomerView(safe), contractor_notes: '' })
    expect(customerSafeQuote(safe)).toEqual(safe)
  })
  it('works for a quote with no materials (markup folded into labor)', () => {
    const q = customerSafeQuote(quote({ material_list: [], price_breakdown: { labor_subtotal: 600, materials_subtotal: 0, rentals_subtotal: 0, raw_cost: 600 }, profit_markup: { markup_percent: 10, markup_dollars: 60, rationale: '' }, final_customer_quote: 660 }))
    expect(q.labor.labor_total).toBe(660)
    expect(isCustomerSafeQuote(q)).toBe(true)
  })
})

describe('splitEstimateForSharing', () => {
  it('moves notes, markup, cost subtotal and the walkthrough out', () => {
    const s = splitEstimateForSharing(quickQuote())
    expect(s.needed).toBe(true)
    expect(s.privateFields).toEqual({
      contractorNotes: 'Verify joists', narration: 'my walkthrough',
      aiMarkupPercent: 20, aiMarkupDollars: 220, aiMarkupRationale: 'tight access', aiCostSubtotal: 1100,
    })
    expect(s.publicPatch.description).toBe('')
    expect(s.publicPatch.materialsTotal).toBe(720)
    expect('laborTotal' in s.publicPatch).toBe(false)   // labor unchanged: markup went into materials
    expect(isCustomerSafeQuote(s.publicPatch.aiQuote)).toBe(true)
  })
  it('leaves a customer-safe estimate alone', () => {
    const { safe } = customerSafeEstimate(quickQuote())
    const again = splitEstimateForSharing(safe)
    expect(again.needed).toBe(false)
    expect(again.publicPatch).toEqual({})
  })
  it('never touches a hand-built estimate\'s description', () => {
    const s = splitEstimateForSharing({ jobTypeId: 'manual', description: 'Replace boards', total: 900 })
    expect(s.needed).toBe(false)
    expect(s.privateFields).toEqual({})
  })
  it('an estimate saved from the editor (markup already folded in) only sheds its notes', () => {
    const edited = customerSafeQuote(quote())
    const s = splitEstimateForSharing({ ...quickQuote({ description: '', materialsTotal: 720 }), aiQuote: { ...edited, contractor_notes: 'call before 9' } })
    expect(s.privateFields).toEqual({ contractorNotes: 'call before 9' })
    expect(Object.keys(s.publicPatch)).toEqual(['aiQuote'])
  })
  it('reports a quote it cannot read instead of guessing', () => {
    const s = splitEstimateForSharing({ aiQuote: { final_customer_quote: 5 } })
    expect(s.error).toBeTruthy()
    expect(s.needed).toBe(false)
    expect(() => customerSafeEstimate({ aiQuote: 'nonsense' })).toThrow()
  })
  it('never changes what the customer sees', () => {
    for (const e of [
      quickQuote(),
      quickQuote({ status: 'approved', signedAtMs: 1, customerResponse: { action: 'approved', signedName: 'Pat', respondedAt: 'x' } }),
      quickQuote({ aiQuote: quote({ material_list: [], price_breakdown: { labor_subtotal: 600, materials_subtotal: 0, rentals_subtotal: 0, raw_cost: 600 }, final_customer_quote: 720 }) }),
    ]) {
      const { safe } = customerSafeEstimate(e)
      expect(customerVisibleContent(safe)).toEqual(customerVisibleContent(e))
    }
  })
})
