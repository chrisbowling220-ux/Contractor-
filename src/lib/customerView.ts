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
    // Distribute markup proportionally across material line items.
    const multiplier = 1 + markupDollars / materialsSubtotal
    nextMaterials = q.material_list.map(m => {
      const newUnitPrice = +(m.unit_price * multiplier).toFixed(2)
      const newLineTotal = +(newUnitPrice * m.quantity_with_waste).toFixed(2)
      return { ...m, unit_price: newUnitPrice, line_total: newLineTotal }
    })
    nextMaterialsSubtotal = +nextMaterials.reduce((s, m) => s + m.line_total, 0).toFixed(2)
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
