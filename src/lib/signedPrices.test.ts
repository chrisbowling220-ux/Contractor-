// A signed estimate is a legal record: every place the app shows, prints,
// emails or bills it must reproduce the figures it was signed with, before
// and after the one-time clean-up stores it customer-safe. And a labor-only
// quote keeps its price, its markup (privately) and its invoice total while
// its hourly rate stops giving the markup away.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIQuote, Estimate } from '../data/types'
import { customerViewFor, hasBeenSigned, toCustomerView, toLegacyCustomerView } from './customerView'
import { customerSafeQuote, customerVisibleContent, isCustomerSafeQuote, splitEstimateForSharing } from './estimatePrivacy'
import { estimateInvoiceLines, sumLines } from './invoiceMath'
import { openEstimatePrintWindow } from './printEstimate'

// A Quick Quote as the old app stored it: raw costs, markup separate.
function rawQuote(): AIQuote {
  return {
    customer_summary: 'New floor', work_scope: 'Install LVP',
    material_list: [
      { name: 'LVP flooring', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 3.29, line_total: 832.37 },
      { name: 'Underlayment', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 0.47, line_total: 118.91 },
      { name: 'Transition strips', base_quantity: 3, waste_percent: 0, quantity_with_waste: 3, quantity_math: '', unit: 'each', unit_price: 18.97, line_total: 56.91 },
    ],
    labor: { estimated_hours: 16, breakdown: '', hourly_rate: 65, labor_total: 1040 },
    price_breakdown: { labor_subtotal: 1040, materials_subtotal: 1008.19, rentals_subtotal: 45, raw_cost: 2093.19 },
    profit_markup: { markup_percent: 20, markup_dollars: 418.64, rationale: 'tight access' },
    final_customer_quote: 2511.83,
    contractor_notes: 'Check subfloor',
  }
}
function laborOnlyQuote(hours = 10, cost = 600, markup = 120): AIQuote {
  return {
    customer_summary: 'Pressure wash', work_scope: 'Wash the house',
    material_list: [],
    labor: { estimated_hours: hours, breakdown: 'Wash', hourly_rate: +(cost / hours).toFixed(2), labor_total: cost },
    price_breakdown: { labor_subtotal: cost, materials_subtotal: 0, rentals_subtotal: 0, raw_cost: cost },
    profit_markup: { markup_percent: 20, markup_dollars: markup, rationale: '' },
    final_customer_quote: +(cost + markup).toFixed(2),
    contractor_notes: '',
  }
}
const signature = { status: 'approved', signedAtMs: 1762000000000, customerResponse: { action: 'approve', signedName: 'Pat Doe', respondedAt: '2026-11-01T12:00:00Z' } }
function est(aiQuote: AIQuote, extra: Record<string, unknown> = {}): Estimate {
  return {
    id: 'e1', createdBy: 'u1', customerName: 'Pat Doe', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote', description: '',
    rateType: 'hourly', hourlyRate: aiQuote.labor.hourly_rate, estimatedHours: aiQuote.labor.estimated_hours,
    laborTotal: aiQuote.labor.labor_total, materials: [], materialsTotal: aiQuote.price_breakdown.materials_subtotal,
    rentals: [], rentalsTotal: aiQuote.price_breakdown.rentals_subtotal, jobLocationZip: '27573', jobLocationRegion: '',
    regionMultiplier: 1, total: aiQuote.final_customer_quote, scopeOfWork: 'Scope', aiQuote, status: 'pending',
    createdAt: '2026-10-01T12:00:00.000Z', ...extra,
  } as Estimate
}
// What the one-time clean-up (2.5) stores.
const cleaned = (e: Estimate): Estimate => {
  const s = splitEstimateForSharing(e as unknown as Record<string, unknown>)
  if (s.error) throw new Error(s.error)
  return { ...e, ...s.publicPatch } as Estimate
}
// The print-out's HTML, minus the "Generated <now>" footer.
function printed(e: Estimate): string {
  let html = ''
  vi.stubGlobal('window', { open: () => ({ document: { write: (s: string) => { html += s }, close: () => {} } }) })
  openEstimatePrintWindow(e, { businessName: 'Bowling Builders' })
  return html.replace(/<div class="footer">[\s\S]*?<\/div>/, '')
}
afterEach(() => { vi.unstubAllGlobals() })

describe('the old rounding, kept for estimates signed with it', () => {
  it('reproduces the live app’s figures exactly (unit price rounded, times the quantity)', () => {
    const v = toLegacyCustomerView(rawQuote())
    expect(v.material_list.map(m => [m.unit_price, m.line_total])).toEqual([[4.66, 1178.98], [0.67, 169.51], [26.85, 80.55]])
    expect(v.price_breakdown.materials_subtotal).toBe(1429.04)
    expect(v.final_customer_quote).toBe(2511.83)
    expect(v.profit_markup).toEqual({ markup_percent: 0, markup_dollars: 0, rationale: '' })
  })
  it('leaves a labor-only quote’s rate as it was printed', () => {
    const v = toLegacyCustomerView(laborOnlyQuote())
    expect(v.labor).toMatchObject({ hourly_rate: 60, labor_total: 720 })
  })
  it('both views leave a customer-safe quote untouched', () => {
    const safe = customerSafeQuote(rawQuote())
    expect(toLegacyCustomerView(safe)).toBe(safe)
    expect(toCustomerView(safe)).toBe(safe)
  })
})

describe('hasBeenSigned', () => {
  it('is the status, or any trace of a signature', () => {
    expect(hasBeenSigned({ status: 'approved' })).toBe(true)
    expect(hasBeenSigned({ status: 'pending', signedAtMs: 1762000000000 })).toBe(true)
    expect(hasBeenSigned({ status: 'pending', customerResponse: { signedName: 'Pat' } })).toBe(true)
    expect(hasBeenSigned({ status: 'pending' })).toBe(false)
    expect(hasBeenSigned({ status: 'declined', customerResponse: { action: 'decline', signedName: '' } })).toBe(false)
  })
})

describe('a signed estimate keeps its figures everywhere', () => {
  it('the app shows it with the old rounding until it is cleaned, an unsigned one with the new', () => {
    expect(customerViewFor({ ...signature, aiQuote: rawQuote() }).price_breakdown.materials_subtotal).toBe(1429.04)
    expect(customerViewFor({ status: 'pending', aiQuote: rawQuote() }).price_breakdown.materials_subtotal).toBe(1426.83)
  })
  it('the clean-up stores exactly those figures, shed of notes and markup, and records the markup privately', () => {
    const e = est(rawQuote(), signature)
    const s = splitEstimateForSharing(e as unknown as Record<string, unknown>)
    const q = s.publicPatch.aiQuote as AIQuote
    expect(q.material_list).toEqual(toLegacyCustomerView(rawQuote()).material_list)
    expect(isCustomerSafeQuote(q)).toBe(true)
    expect(s.publicPatch.materialsTotal).toBe(1429.04)
    expect(s.privateFields).toMatchObject({ aiMarkupPercent: 20, aiMarkupDollars: 418.64, contractorNotes: 'Check subfloor' })
    expect(customerVisibleContent(e as unknown as Record<string, unknown>)).toEqual(customerVisibleContent(cleaned(e) as unknown as Record<string, unknown>))
    // The signature, status and total are never part of the patch.
    for (const k of ['status', 'signedAtMs', 'customerResponse', 'total', 'createdAt', 'proposal', 'scopeOfWork']) expect(k in s.publicPatch).toBe(false)
  })
  it('prints the same document before and after the clean-up', () => {
    const e = est(rawQuote(), signature)
    const before = printed(e)
    expect(before).toContain('$4.66')
    expect(before).toContain('$1429.04')
    expect(before).toContain('$2511.83')
    expect(printed(cleaned(e))).toBe(before)
  })
  it('bills the same lines before and after the clean-up, adding up to the signed total', () => {
    const e = est(rawQuote(), signature)
    const a = estimateInvoiceLines(e, 'Flooring')
    expect(estimateInvoiceLines(cleaned(e), 'Flooring')).toEqual(a)
    expect(sumLines(a)).toBe(2511.83)
  })
  it('a signed labor-only estimate keeps the rate it was signed with (the planner reports it)', () => {
    const e = est(laborOnlyQuote(), signature)
    const s = splitEstimateForSharing(e as unknown as Record<string, unknown>)
    expect((s.publicPatch.aiQuote as AIQuote).labor).toMatchObject({ hourly_rate: 60, labor_total: 720 })
    expect('hourlyRate' in s.publicPatch).toBe(false)
    expect(printed(cleaned(e))).toBe(printed(e))
  })
})

describe('labor-only quotes (D1): price, rate, markup and invoice', () => {
  it('folds the markup into the rate; the price and total never move; the markup is kept privately', () => {
    const e = est(laborOnlyQuote())
    const s = splitEstimateForSharing(e as unknown as Record<string, unknown>)
    const q = s.publicPatch.aiQuote as AIQuote
    expect(q.labor).toMatchObject({ estimated_hours: 10, hourly_rate: 72, labor_total: 720 })
    expect(q.final_customer_quote).toBe(720)
    expect(s.publicPatch).toMatchObject({ hourlyRate: 72, laborTotal: 720 })
    expect(s.privateFields).toMatchObject({ aiMarkupPercent: 20, aiMarkupDollars: 120, aiCostSubtotal: 600 })
    expect(JSON.stringify(cleaned(e))).not.toMatch(/"(hourly_rate|hourlyRate)":60\b/)
  })
  it('the print-out shows hours × the marked-up rate, the same before and after the clean-up', () => {
    const e = est(laborOnlyQuote())
    const html = printed(e)
    expect(html).toContain('10 hours @ $72/hr')
    expect(html).not.toContain('$60/hr')
    expect(printed(cleaned(e))).toBe(html)
  })
  it('invoices the full price (one line, no rate shown), before and after the clean-up', () => {
    const e = est(laborOnlyQuote())
    const lines = estimateInvoiceLines(e, 'Pressure washing')
    expect(lines).toEqual([{ name: 'Pressure washing (per estimate)', quantity: 1, unitPrice: 720, lineTotal: 720 }])
    expect(estimateInvoiceLines(cleaned(e), 'Pressure washing')).toEqual(lines)
  })
  it('when the rate cannot be exact to the cent, the labor price and the total still are', () => {
    const e = est(laborOnlyQuote(7, 833.33, 166.67))   // $1,000.00 over 7 hours
    const c = cleaned(e)
    expect(c.aiQuote!.labor).toMatchObject({ hourly_rate: 142.86, labor_total: 1000 })
    expect(c.aiQuote!.final_customer_quote).toBe(1000)
    expect(sumLines(estimateInvoiceLines(c, 'Painting'))).toBe(1000)
  })
})
