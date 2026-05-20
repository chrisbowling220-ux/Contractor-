import type { AIQuote, MaterialLine, RentalLine } from '../data/types'

const WASTE_BY_CATEGORY: Record<string, number> = {
  tile: 12, paint: 5, drywall: 10, lumber: 10, flooring: 10, insulation: 8, roofing: 10,
}

function wasteFor(name: string): number {
  const n = name.toLowerCase()
  for (const [k, v] of Object.entries(WASTE_BY_CATEGORY)) {
    if (n.includes(k)) return v
  }
  return 10
}

interface FallbackInput {
  customerName: string
  jobTypeName: string
  description: string
  jobLocationZip: string
  materials: MaterialLine[]
  rentals: RentalLine[]
  hourlyRate: number
  estimatedHours: number
  markupPercent: number
  flatAmount?: number
  rateType: 'flat' | 'hourly'
}

// Builds an AI-shaped quote without calling Claude. Used as a fallback when
// the API is unavailable so the contractor still gets a usable quote.
export function buildFallbackQuote(input: FallbackInput): AIQuote {
  const material_list = input.materials.map(m => {
    const waste = wasteFor(m.name)
    const qty_with_waste = Math.ceil(m.quantity * (1 + waste / 100))
    const line_total = +(qty_with_waste * m.unitPrice).toFixed(2)
    return {
      name: m.name,
      base_quantity: m.quantity,
      waste_percent: waste,
      quantity_with_waste: qty_with_waste,
      quantity_math: `${m.quantity} × ${1 + waste / 100} (${waste}% waste) = ${qty_with_waste} ${m.unit}`,
      unit: m.unit,
      unit_price: m.unitPrice,
      line_total,
    }
  })

  const materials_subtotal = +material_list.reduce((s, m) => s + m.line_total, 0).toFixed(2)
  const rentals_subtotal = +input.rentals.reduce((s, r) => s + r.days * r.dailyRate, 0).toFixed(2)
  const labor_total =
    input.rateType === 'flat'
      ? +(input.flatAmount ?? 0).toFixed(2)
      : +(input.hourlyRate * input.estimatedHours).toFixed(2)
  const raw_cost = +(labor_total + materials_subtotal + rentals_subtotal).toFixed(2)
  const markup_dollars = +(raw_cost * (input.markupPercent / 100)).toFixed(2)
  const final_customer_quote = +(raw_cost + markup_dollars).toFixed(2)

  const work_scope = [
    `JOB: ${input.jobTypeName}`,
    input.description ? `\nDESCRIPTION:\n${input.description}` : '',
    `\nMATERIALS:\n${material_list.map(m => `- ${m.name}: ${m.quantity_with_waste} ${m.unit}`).join('\n') || '(none)'}`,
    input.rentals.length ? `\nRENTALS:\n${input.rentals.map(r => `- ${r.name}: ${r.days} day(s)`).join('\n')}` : '',
    `\nLABOR: ${input.rateType === 'flat' ? `$${labor_total.toFixed(2)} flat` : `${input.estimatedHours}h × $${input.hourlyRate}/hr = $${labor_total.toFixed(2)}`}`,
  ].filter(Boolean).join('\n')

  return {
    customer_summary: `Estimate for ${input.customerName}: ${input.jobTypeName}. ${input.description || ''} Final price reflects materials with realistic waste factors, labor at $${input.hourlyRate}/hr, and a ${input.markupPercent}% markup. Generated offline — AI service was unavailable, so this is a calculated estimate without AI-assisted scope writing.`,
    work_scope,
    material_list,
    labor: {
      estimated_hours: input.estimatedHours,
      breakdown: `${input.estimatedHours} hours @ $${input.hourlyRate}/hour`,
      hourly_rate: input.hourlyRate,
      labor_total,
    },
    price_breakdown: {
      labor_subtotal: labor_total,
      materials_subtotal,
      rentals_subtotal,
      raw_cost,
    },
    profit_markup: {
      markup_percent: input.markupPercent,
      markup_dollars,
      rationale: `Standard ${input.markupPercent}% markup applied (fallback calculation).`,
    },
    final_customer_quote,
    contractor_notes: 'AI quote service was unavailable — this quote was generated locally using your form inputs and standard waste factors. Review materials and labor estimates before sending to customer.',
  }
}
