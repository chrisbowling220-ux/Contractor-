// Shared JSON schema for the AI quote document. Both generateAIQuote (form-driven)
// and analyzeScan (camera + voice) return responses constrained to this shape so
// the client can render either with the same preview UI.

export const aiQuoteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customer_summary: { type: 'string' },
    work_scope: { type: 'string' },
    material_list: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          base_quantity: { type: 'number' },
          waste_percent: { type: 'number' },
          quantity_with_waste: { type: 'number' },
          quantity_math: { type: 'string' },
          unit: { type: 'string' },
          unit_price: { type: 'number' },
          line_total: { type: 'number' },
        },
        required: [
          'name', 'base_quantity', 'waste_percent', 'quantity_with_waste',
          'quantity_math', 'unit', 'unit_price', 'line_total',
        ],
      },
    },
    labor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        estimated_hours: { type: 'number' },
        breakdown: { type: 'string' },
        hourly_rate: { type: 'number' },
        labor_total: { type: 'number' },
      },
      required: ['estimated_hours', 'breakdown', 'hourly_rate', 'labor_total'],
    },
    price_breakdown: {
      type: 'object',
      additionalProperties: false,
      properties: {
        labor_subtotal: { type: 'number' },
        materials_subtotal: { type: 'number' },
        rentals_subtotal: { type: 'number' },
        raw_cost: { type: 'number' },
      },
      required: ['labor_subtotal', 'materials_subtotal', 'rentals_subtotal', 'raw_cost'],
    },
    profit_markup: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markup_percent: { type: 'number' },
        markup_dollars: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['markup_percent', 'markup_dollars', 'rationale'],
    },
    final_customer_quote: { type: 'number' },
    contractor_notes: { type: 'string' },
  },
  required: [
    'customer_summary', 'work_scope', 'material_list', 'labor',
    'price_breakdown', 'profit_markup', 'final_customer_quote', 'contractor_notes',
  ],
} as const

export const ARITHMETIC_RULES = `Numbers must add up:
- quantity_with_waste × unit_price = line_total (per material line)
- sum of line_totals = materials_subtotal
- labor_subtotal + materials_subtotal + rentals_subtotal = raw_cost
- raw_cost + markup_dollars = final_customer_quote
- markup_dollars = raw_cost × (markup_percent / 100)`
