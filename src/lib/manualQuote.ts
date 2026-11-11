import type { AIQuote, Estimate } from '../data/types'

// An estimate built by hand (Build Manually) stores its materials and labor in
// the estimate's own fields and has no itemised `aiQuote`. The editor and the
// invoice builder both work from an itemised quote, so this converts one into
// the other. Without it the editor opened a hand-built estimate with NO
// materials and, for flat-rate jobs, no labor either, and saving any edit
// rewrote the total without them.
//
// The result always adds up from the estimate's own figures: line totals are
// qty × price, labor is the stored labor price, and nothing is marked up
// (a hand-built estimate is entered at customer prices).
export function quoteFromManualEstimate(e: Estimate): AIQuote {
  const material_list = (e.materials || []).map(m => {
    const qty = Number(m.quantity) || 0
    const price = Number(m.unitPrice) || 0
    return {
      name: m.name, base_quantity: qty, waste_percent: 0, quantity_with_waste: qty,
      quantity_math: '', unit: m.unit || 'each', unit_price: price, line_total: +(qty * price).toFixed(2),
    }
  })
  const materials_subtotal = +material_list.reduce((s, m) => s + m.line_total, 0).toFixed(2)
  const rentals_subtotal = +(Number(e.rentalsTotal) || 0).toFixed(2)
  const flat = e.rateType === 'flat'
  // The editor prices labor as hours × rate. A flat price is carried as one
  // unit at the flat amount so it survives an edit unchanged.
  const hours = flat ? 1 : (Number(e.estimatedHours) || 0)
  const rate = flat ? (Number(e.flatAmount) || Number(e.laborTotal) || 0) : (Number(e.hourlyRate) || 0)
  const labor_total = +(hours * rate).toFixed(2)
  const total = +(materials_subtotal + labor_total + rentals_subtotal).toFixed(2)
  return {
    customer_summary: '',
    work_scope: e.description || '',
    material_list,
    labor: { estimated_hours: hours, breakdown: flat ? 'Flat rate' : `${hours} hours @ $${rate}/hour`, hourly_rate: rate, labor_total },
    price_breakdown: { labor_subtotal: labor_total, materials_subtotal, rentals_subtotal, raw_cost: total },
    profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' },
    final_customer_quote: total,
    contractor_notes: '',
  }
}
