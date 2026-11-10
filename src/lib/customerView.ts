import type { AIQuote, AIMaterialLine } from '../data/types'

// Returns an AIQuote where the markup has been baked into the material unit
// prices (and line totals), and the markup section is zeroed out. Final grand
// total is preserved — customer sees the same number, just no "markup" line.
//
// If the quote has no materials, the markup gets baked into labor instead
// (otherwise it would silently disappear from the total).
export function toCustomerView(q: AIQuote): AIQuote {
  const markupDollars = q.profit_markup?.markup_dollars || 0
  if (markupDollars <= 0) return q

  const materialsSubtotal = q.price_breakdown.materials_subtotal
  const hasMaterials = q.material_list.length > 0 && materialsSubtotal > 0

  let nextMaterials: AIMaterialLine[] = q.material_list
  let nextLabor = q.labor
  let nextMaterialsSubtotal = materialsSubtotal
  let nextLaborSubtotal = q.price_breakdown.labor_subtotal

  if (hasMaterials) {
    // Distribute markup proportionally across material line items. Work on the
    // LINE TOTALS (not the unit prices) and hand any leftover cents to the
    // biggest line, so the lines add up to exactly materials + markup. Rounding
    // the unit price first and multiplying back by the quantity drifts by
    // dollars on large quantities, and then the breakdown no longer matches the
    // total the customer signed.
    const target = +(materialsSubtotal + markupDollars).toFixed(2)
    const multiplier = target / materialsSubtotal
    const totals = q.material_list.map(m => +((Number(m.line_total) || 0) * multiplier).toFixed(2))
    const drift = +(target - totals.reduce((s, t) => s + t, 0)).toFixed(2)
    if (drift !== 0) {
      const biggest = totals.indexOf(Math.max(...totals))
      totals[biggest] = +(totals[biggest] + drift).toFixed(2)
    }
    nextMaterials = q.material_list.map((m, i) => {
      const qty = Number(m.quantity_with_waste) || 0
      const newUnitPrice = qty > 0 ? +(totals[i] / qty).toFixed(2) : +(m.unit_price * multiplier).toFixed(2)
      return { ...m, unit_price: newUnitPrice, line_total: totals[i] }
    })
    nextMaterialsSubtotal = target
  } else {
    // No materials — bake into labor so the total still adds up.
    const newLaborTotal = +(q.labor.labor_total + markupDollars).toFixed(2)
    nextLabor = { ...q.labor, labor_total: newLaborTotal }
    nextLaborSubtotal = newLaborTotal
  }

  const rawCost = +(nextLaborSubtotal + nextMaterialsSubtotal + q.price_breakdown.rentals_subtotal).toFixed(2)

  return {
    ...q,
    material_list: nextMaterials,
    labor: nextLabor,
    price_breakdown: {
      ...q.price_breakdown,
      materials_subtotal: nextMaterialsSubtotal,
      labor_subtotal: nextLaborSubtotal,
      raw_cost: rawCost,
    },
    profit_markup: {
      markup_percent: 0,
      markup_dollars: 0,
      rationale: '',
    },
    // final_customer_quote stays the same — markup just got redistributed.
  }
}
