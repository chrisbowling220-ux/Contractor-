// What an estimate share link may reveal, kept apart from what it may not.
//
// Customers open an estimate by its link id without signing in, and the
// database hands them the WHOLE estimate document, not just what the page
// draws. So anything stored on it is readable by whoever holds the link (or
// by anyone they forward it to), through the browser's developer tools or the
// database's web API.
//
// An AI quote used to be stored exactly as the AI wrote it:
//   - contractor_notes: risks, assumptions, "price these fixtures before
//     sending", which the AI is told are private to the contractor,
//   - profit_markup: the markup percent, dollars and the AI's reasoning,
//   - material prices and subtotals BEFORE markup, so the markup could be
//     worked out by subtraction even with the markup section hidden,
// and a Quick Quote's `description` held the contractor's spoken walkthrough.
//
// The estimate now holds only the customer view (markup folded into the
// prices, exactly what the page has always drawn), and the private parts
// live in estimatePrivate/{estimateId}, which only the contractor can read.
//
// Pure (no Firebase): used by the app when it saves, by the one-time
// migration script, and by the tests.
import type { AIQuote } from '../data/types'
// Explicit extension: the migration script loads this file directly in Node.
import { toCustomerView } from './customerView.ts'

export const ESTIMATE_PRIVATE_COLLECTION = 'estimatePrivate'

// estimatePrivate/{estimateId}. Every field but createdBy is optional: only
// what an estimate actually had is stored.
export interface EstimatePrivate {
  createdBy: string
  contractorNotes?: string     // the quote's private notes (editable in the app)
  narration?: string           // a Quick Quote's spoken walkthrough
  aiMarkupPercent?: number     // what the AI first proposed, kept for the record
  aiMarkupDollars?: number
  aiMarkupRationale?: string
  aiCostSubtotal?: number      // the AI's cost before markup
  updatedAt?: string
}

export const ESTIMATE_PRIVATE_FIELDS = [
  'createdBy', 'contractorNotes', 'narration', 'aiMarkupPercent', 'aiMarkupDollars',
  'aiMarkupRationale', 'aiCostSubtotal', 'updatedAt',
] as const

// Quick Quote estimates store the spoken walkthrough in `description`; a
// hand-built estimate stores its customer-facing scope there and keeps it.
export const QUICK_QUOTE_JOB_TYPE = 'quick-quote'

export interface SharingSplit {
  // Fields to set on the estimate. Empty when it is already customer-safe.
  publicPatch: Record<string, unknown>
  // Private values that were on the estimate (no createdBy / updatedAt).
  privateFields: Omit<EstimatePrivate, 'createdBy' | 'updatedAt'>
  // True when the estimate held anything private (publicPatch is non-empty).
  needed: boolean
  // Set when the stored quote could not be read; nothing should be written.
  error?: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

// The quote as the customer sees it, with the private sections emptied.
// toCustomerView folds any markup into the prices and leaves the total alone;
// on a quote that is already customer-safe it changes nothing.
export function customerSafeQuote(q: AIQuote): AIQuote {
  const view = toCustomerView(q)
  return {
    ...view,
    profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' },
    contractor_notes: '',
  }
}

export function isCustomerSafeQuote(q: unknown): boolean {
  if (!q || typeof q !== 'object') return true
  const a = q as Partial<AIQuote>
  const pm = (a.profit_markup || {}) as Partial<AIQuote['profit_markup']>
  return text(a.contractor_notes) === ''
    && num(pm.markup_dollars) === 0
    && num(pm.markup_percent) === 0
    && text(pm.rationale) === ''
}

function readableQuote(q: unknown): q is AIQuote {
  if (!q || typeof q !== 'object') return false
  const a = q as Partial<AIQuote>
  return Array.isArray(a.material_list)
    && !!a.labor && typeof a.labor === 'object'
    && !!a.price_breakdown && typeof a.price_breakdown === 'object'
}

// Split an estimate (as stored, or about to be stored) into what may stay on
// the shared document and what must move to estimatePrivate.
export function splitEstimateForSharing(e: Record<string, unknown>): SharingSplit {
  const publicPatch: Record<string, unknown> = {}
  const privateFields: SharingSplit['privateFields'] = {}

  const ai = e.aiQuote
  if (ai !== undefined && ai !== null) {
    if (!readableQuote(ai)) {
      return { publicPatch: {}, privateFields: {}, needed: false, error: 'aiQuote is not in the expected shape' }
    }
    const notes = text(ai.contractor_notes).trim()
    const pm = (ai.profit_markup || {}) as Partial<AIQuote['profit_markup']>
    const markupDollars = num(pm.markup_dollars)
    const markupPercent = num(pm.markup_percent)
    const rationale = text(pm.rationale).trim()

    if (notes) privateFields.contractorNotes = notes
    if (markupDollars || markupPercent || rationale) {
      privateFields.aiMarkupPercent = markupPercent
      privateFields.aiMarkupDollars = markupDollars
      if (rationale) privateFields.aiMarkupRationale = rationale
      privateFields.aiCostSubtotal = num(ai.price_breakdown.raw_cost)
    }

    const safe = customerSafeQuote(ai)
    if (!isCustomerSafeQuote(ai)) publicPatch.aiQuote = safe

    // The headline subtotals must match the customer view too: a cost-price
    // materials subtotal next to the marked-up total gives the markup away.
    const subtotals: Record<string, number> = {
      laborTotal: num(safe.labor.labor_total),
      materialsTotal: num(safe.price_breakdown.materials_subtotal),
      rentalsTotal: num(safe.price_breakdown.rentals_subtotal),
    }
    for (const [k, v] of Object.entries(subtotals)) {
      if (k in e && num(e[k]) !== v) publicPatch[k] = v
    }
  }

  if (e.jobTypeId === QUICK_QUOTE_JOB_TYPE) {
    const narration = text(e.description).trim()
    if (narration) {
      privateFields.narration = narration
      publicPatch.description = ''
    }
  }

  return { publicPatch, privateFields, needed: Object.keys(publicPatch).length > 0 }
}

// The estimate with its private parts removed, ready to save.
export function customerSafeEstimate<T extends Record<string, unknown>>(e: T): { safe: T; privateFields: SharingSplit['privateFields'] } {
  const s = splitEstimateForSharing(e)
  if (s.error) throw new Error(`Cannot prepare estimate for sharing: ${s.error}`)
  return { safe: { ...e, ...s.publicPatch } as T, privateFields: s.privateFields }
}

// Everything a customer can see on the estimate page, print-out and email,
// as one comparable value. The migration refuses to change a document whose
// customer-visible content would differ after the split.
export function customerVisibleContent(e: Record<string, unknown>): unknown {
  const ai = e.aiQuote
  let quote: unknown = null
  if (readableQuote(ai)) {
    const v = toCustomerView(ai)
    quote = { ...v, contractor_notes: '', profit_markup: null }
  }
  const pick = (k: string) => (k in e ? e[k] : null)
  return {
    quote,
    customerName: pick('customerName'),
    jobTypeName: pick('jobTypeName'),
    scopeOfWork: pick('scopeOfWork'),
    total: pick('total'),
    status: pick('status'),
    depositRequested: pick('depositRequested'),
    depositAmount: pick('depositAmount'),
    proposedStartDate: pick('proposedStartDate'),
    proposal: pick('proposal'),
    customerResponse: pick('customerResponse'),
    signedAtMs: pick('signedAtMs'),
    startDateResponse: pick('startDateResponse'),
    jobLocationZip: pick('jobLocationZip'),
    createdAt: pick('createdAt'),
    revision: pick('revision'),
    supersededBy: pick('supersededBy'),
    // A hand-built estimate shows its description as the scope.
    description: e.jobTypeId === QUICK_QUOTE_JOB_TYPE ? null : pick('description'),
  }
}
