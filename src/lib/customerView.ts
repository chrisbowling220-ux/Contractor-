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
    // No materials — bake into labor so the total still adds up. Into the
    // hourly rate too: the print-out, the estimate email and the invoice line
    // all show "hours × rate", so leaving the cost rate next to a marked-up
    // labor total would give the markup away by subtraction (10 h × $60 =
    // $600, shown as $720). The editor also recomputes labor as hours × rate,
    // and with the cost rate it dropped the markup from the price on save.
    const newLaborTotal = +(q.labor.labor_total + markupDollars).toFixed(2)
    const hours = Number(q.labor.estimated_hours) || 0
    const hourlyRate = hours > 0 ? +(newLaborTotal / hours).toFixed(2) : q.labor.hourly_rate
    nextLabor = { ...q.labor, labor_total: newLaborTotal, hourly_rate: hourlyRate }
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

// ── Signed estimates keep the prices they were signed with ─────────────────
//
// Until this release the app folded the markup by rounding each unit price
// first and multiplying back by the quantity (below, unchanged). That drifts
// by cents per line, so toCustomerView above now works on the line totals.
// But an estimate the customer has ALREADY signed was printed and emailed
// with the old figures, and re-printing it must reproduce the same document,
// cent for cent, not a re-rounded one. So a signed estimate whose quote still
// carries its markup (that is, one signed before its markup was folded in
// and stored) is shown with the old rounding, labor-only quotes included
// (their hourly rate is left as it was printed). Once a quote is stored
// customer-safe (markup 0) both functions return it unchanged, so this only
// decides how the one-time clean-up stores the 2026 estimates signed before
// it, and what the app shows for them until then.
export function toLegacyCustomerView(q: AIQuote): AIQuote {
  const markupDollars = q.profit_markup?.markup_dollars || 0
  if (markupDollars <= 0) return q

  const materialsSubtotal = q.price_breakdown.materials_subtotal
  const hasMaterials = q.material_list.length > 0 && materialsSubtotal > 0

  let nextMaterials: AIMaterialLine[] = q.material_list
  let nextLabor = q.labor
  let nextMaterialsSubtotal = materialsSubtotal
  let nextLaborSubtotal = q.price_breakdown.labor_subtotal

  if (hasMaterials) {
    const multiplier = 1 + markupDollars / materialsSubtotal
    nextMaterials = q.material_list.map(m => {
      const newUnitPrice = +(m.unit_price * multiplier).toFixed(2)
      const newLineTotal = +(newUnitPrice * m.quantity_with_waste).toFixed(2)
      return { ...m, unit_price: newUnitPrice, line_total: newLineTotal }
    })
    nextMaterialsSubtotal = +nextMaterials.reduce((s, m) => s + m.line_total, 0).toFixed(2)
  } else {
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
  }
}

// Signed, or signed once: the status, or any trace of a signature (an older
// app reset an edited signed estimate to "pending" but left signedAtMs).
export function hasBeenSigned(e: { status?: unknown; signedAtMs?: unknown; customerResponse?: unknown }): boolean {
  if (e.status === 'approved') return true
  if (typeof e.signedAtMs === 'number' && e.signedAtMs > 0) return true
  const r = e.customerResponse as { signedName?: unknown } | null | undefined
  return !!(r && typeof r === 'object' && typeof r.signedName === 'string' && r.signedName.trim())
}

// The quote as the customer sees it, for a given estimate: everywhere the app
// shows, prints, emails or bills an estimate's prices goes through here.
export function customerViewFor(e: { aiQuote: AIQuote; status?: unknown; signedAtMs?: unknown; customerResponse?: unknown }): AIQuote {
  return hasBeenSigned(e) ? toLegacyCustomerView(e.aiQuote) : toCustomerView(e.aiQuote)
}
