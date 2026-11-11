import { describe, expect, it } from 'vitest'
import type { Estimate } from '../data/types'
import { estimateInvoiceLines, sumLines } from './invoiceMath'
import { quoteFromManualEstimate } from './manualQuote'

function manual(extra: Partial<Estimate> = {}): Estimate {
  return {
    id: 'm1', customerName: 'Pat Doe', jobTypeId: 'manual', jobTypeName: 'Deck repair', description: 'Replace rotted boards',
    rateType: 'hourly', hourlyRate: 70, estimatedHours: 10, laborTotal: 700,
    materials: [{ materialId: 'custom', name: 'Pressure-treated 2x6', quantity: 40, unit: 'each', unitPrice: 12.5 }],
    materialsTotal: 500, rentals: [], rentalsTotal: 0, jobLocationZip: '27573', jobLocationRegion: '', regionMultiplier: 1,
    total: 1200, scopeOfWork: '', status: 'pending', createdAt: '2026-11-01T12:00:00.000Z', ...extra,
  }
}

describe('estimates built by hand', () => {
  it('open in the editor with their materials and labor, at the same total', () => {
    const q = quoteFromManualEstimate(manual())
    expect(q.material_list).toHaveLength(1)
    expect(q.material_list[0]).toMatchObject({ name: 'Pressure-treated 2x6', quantity_with_waste: 40, unit_price: 12.5, line_total: 500 })
    expect(q.labor).toMatchObject({ estimated_hours: 10, hourly_rate: 70, labor_total: 700 })
    expect(q.final_customer_quote).toBe(1200)
    expect(q.profit_markup.markup_dollars).toBe(0)
    expect(q.work_scope).toBe('Replace rotted boards')
  })
  it('keep a flat labor price (the editor used to turn it into $0)', () => {
    const q = quoteFromManualEstimate(manual({ rateType: 'flat', flatAmount: 950, hourlyRate: 65, estimatedHours: 0, laborTotal: 950, total: 1450 }))
    expect(q.labor.labor_total).toBe(950)
    expect(q.final_customer_quote).toBe(1450)
  })
  it('include rentals and labor-only jobs', () => {
    expect(quoteFromManualEstimate(manual({ rentalsTotal: 180, total: 1380 })).final_customer_quote).toBe(1380)
    expect(quoteFromManualEstimate(manual({ materials: [], materialsTotal: 0, total: 700 })).final_customer_quote).toBe(700)
  })
  it('invoice line by line and add up to the signed total', () => {
    const lines = estimateInvoiceLines(manual(), 'Deck repair')
    expect(lines.map(l => l.name)).toEqual(['Pressure-treated 2x6', 'Labor — 10 hours @ $70/hr'])
    expect(sumLines(lines)).toBe(1200)
    const flat = estimateInvoiceLines(manual({ rateType: 'flat', flatAmount: 950, laborTotal: 950, total: 1450 }), 'Deck repair')
    expect(flat.map(l => l.name)).toContain('Labor (flat rate)')
    expect(sumLines(flat)).toBe(1450)
  })
})
