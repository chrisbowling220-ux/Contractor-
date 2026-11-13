// Pure money math for invoices: line items, balances, payments and numbering.
// No Firebase in here on purpose, so every rule below is covered by unit tests
// (invoiceMath.test.ts) and the same functions drive the editor, the project
// screen, the dashboard and the public invoice page.
import type { ChangeOrder, Estimate, Invoice, InvoiceLine, InvoicePayment, PaymentMethod } from '../data/types'
import { customerViewFor } from './customerView'
import { quoteFromManualEstimate } from './manualQuote'
import { bindingVersions } from './estimateRevision'

export const money = (n: number): number => +(Number(n) || 0).toFixed(2)

// ── Line items ───────────────────────────────────────────────────────────────

// Lines for ONE estimate. They always add up to estimate.total, because that is
// the figure the customer saw and signed.
//
// The stored quote keeps the contractor's markup as a separate, internal figure
// (materials + labor + rentals = raw cost; markup on top). Billing the raw
// lines as they sit would leave the markup off the invoice, so the quote goes
// through the customer view first (customerViewFor), which folds the markup
// into the prices exactly the way the estimate was shown and signed.
export function estimateInvoiceLines(e: Estimate, jobTypeName: string): InvoiceLine[] {
  const total = money(e.total)
  const lines: InvoiceLine[] = []
  // Hand-built estimates carry their items on the estimate itself.
  // A signed estimate is billed at the line prices it was signed with.
  const ai = e.aiQuote ? customerViewFor({ ...e, aiQuote: e.aiQuote }) : (e.materials?.length ? quoteFromManualEstimate(e) : null)

  if (ai && ai.material_list.length > 0) {
    for (const m of ai.material_list) {
      lines.push({
        name: m.name,
        quantity: Number(m.quantity_with_waste) || 0,
        unitPrice: money(m.unit_price),
        lineTotal: money(m.line_total),
      })
    }
    const labor = ai.labor
    if (labor && labor.labor_total > 0) {
      lines.push({
        name: labor.breakdown === 'Flat rate' ? 'Labor (flat rate)' : `Labor — ${labor.estimated_hours} hours @ $${labor.hourly_rate}/hr`,
        quantity: 1,
        unitPrice: money(labor.labor_total),
        lineTotal: money(labor.labor_total),
      })
    }
    const rentals = money(ai.price_breakdown.rentals_subtotal)
    if (rentals > 0) {
      lines.push({ name: 'Rental equipment', quantity: 1, unitPrice: rentals, lineTotal: rentals })
    }
    // Whatever the breakdown doesn't account for (older quotes rounded their
    // prices differently) is shown as its own line instead of being dropped.
    const gap = money(total - lines.reduce((s, l) => s + l.lineTotal, 0))
    if (gap !== 0) {
      lines.push({ name: 'Adjustment to agreed estimate total', quantity: 1, unitPrice: gap, lineTotal: gap })
    }
  } else {
    lines.push({ name: `${jobTypeName} (per estimate)`, quantity: 1, unitPrice: total, lineTotal: total })
  }
  return lines
}

// Estimates that count toward what the customer owes: everything the customer
// has not declined, and of a revised estimate only the version that binds
// (the newest one the customer signed), so a revision is never billed on top
// of the version it replaces.
export const billableEstimates = (estimates: Estimate[]): Estimate[] =>
  bindingVersions(estimates).filter(e => e.status !== 'declined')

// The contract value of a job: its live estimates plus APPROVED change orders.
// Pending and declined change orders never change what is owed.
export function contractTotal(estimates: Estimate[], changeOrders: ChangeOrder[]): number {
  const quotes = billableEstimates(estimates).reduce((s, e) => s + (Number(e.total) || 0), 0)
  const changes = changeOrders.reduce((s, c) => s + (c.status === 'approved' ? (Number(c.delta) || 0) : 0), 0)
  return money(quotes + changes)
}

// The total a NEW change order starts from: the contract as it stands, not
// counting the change order being edited (it would otherwise count itself).
export function changeOrderBaseTotal(estimates: Estimate[], changeOrders: ChangeOrder[], editingId?: string): number {
  return contractTotal(estimates, changeOrders.filter(c => c.id !== editingId))
}

// Every line for a final invoice: each live estimate, then each approved change
// order. The sum equals contractTotal() for the same inputs.
export function buildInvoiceLineItems(estimates: Estimate[], changeOrders: ChangeOrder[], jobTypeName: string): InvoiceLine[] {
  const lines: InvoiceLine[] = []
  for (const e of billableEstimates(estimates)) lines.push(...estimateInvoiceLines(e, jobTypeName))
  for (const co of changeOrders.filter(c => c.status === 'approved')) {
    const delta = money(co.delta)
    lines.push({ name: `Change Order: ${co.description}`, quantity: 1, unitPrice: delta, lineTotal: delta })
  }
  return lines
}

export const sumLines = (lines: InvoiceLine[]): number => money(lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0))

// ── Balances and payments ────────────────────────────────────────────────────
//
// An invoice's money fields:
//   subtotal    what the invoice is for
//   amountPaid  everything already counted against it: a deposit credited when
//               it was created, plus every payment recorded since
//   amountDue   subtotal − amountPaid, never below zero. This is the number the
//               card checkout charges, so recording a part payment lowers what
//               the customer is asked to pay online.
//   payments    the history of payments the contractor recorded by hand (cash,
//               check, …) and card payments recorded by the Stripe webhook.
//
// Recording a payment here is BOOKKEEPING ONLY. It never moves money.

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash', check: 'Check', card: 'Card (online)', zelle: 'Zelle', venmo: 'Venmo',
  bank_transfer: 'Bank transfer', other: 'Other',
}

export function balanceOf(subtotal: number, amountPaid: number): number {
  return Math.max(0, money(subtotal - amountPaid))
}

type InvoiceMoney = Pick<Invoice, 'subtotal' | 'amountPaid' | 'amountDue' | 'status' | 'payments' | 'paidAt' | 'paidAtMs' | 'customerCashChoice'>

export interface PaymentUpdate {
  payments: InvoicePayment[]
  amountPaid: number
  amountDue: number
  status: Invoice['status']
  paidAt?: string
  paidAtMs?: number
}

// Returns the fields to write when a payment is recorded. Throws a plain-English
// error for an amount that makes no sense, so the form can show it.
export function recordPayment(
  inv: InvoiceMoney,
  payment: { amount: number; method: PaymentMethod; date: string; note?: string },
  now: Date = new Date(),
  id: string = `pay_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
): PaymentUpdate {
  const amount = money(payment.amount)
  const due = balanceOf(inv.subtotal, inv.amountPaid || 0)
  if (inv.status === 'paid' || due <= 0) throw new Error('This invoice is already paid in full.')
  if (!(amount > 0)) throw new Error('Enter a payment amount greater than zero.')
  if (amount > due) throw new Error(`That is more than the $${due.toFixed(2)} still owed on this invoice.`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.date)) throw new Error('Pick the date the payment was received.')

  const entry: InvoicePayment = {
    id, amount, method: payment.method, date: payment.date,
    recordedAt: now.toISOString(), source: 'manual',
    ...(payment.note?.trim() ? { note: payment.note.trim().slice(0, 300) } : {}),
  }
  const amountPaid = money((inv.amountPaid || 0) + amount)
  const amountDue = balanceOf(inv.subtotal, amountPaid)
  const paidOff = amountDue === 0
  return {
    payments: [...(inv.payments || []), entry],
    amountPaid,
    amountDue,
    status: paidOff ? 'paid' : inv.status,
    ...(paidOff ? { paidAt: now.toISOString(), paidAtMs: now.getTime() } : {}),
  }
}

// Undo a hand-recorded payment (typo, bounced check). Card payments recorded by
// Stripe can't be removed here: the refund has to happen in Stripe.
export function removePayment(inv: InvoiceMoney, paymentId: string): Omit<PaymentUpdate, 'paidAt' | 'paidAtMs'> & { reopened: boolean } {
  const target = (inv.payments || []).find(p => p.id === paymentId)
  if (!target) throw new Error('That payment is no longer on this invoice.')
  if (target.source === 'stripe') throw new Error('Card payments are recorded by Stripe and can\'t be removed here. Refund it from your Stripe dashboard.')
  const payments = (inv.payments || []).filter(p => p.id !== paymentId)
  const amountPaid = Math.max(0, money((inv.amountPaid || 0) - target.amount))
  const amountDue = balanceOf(inv.subtotal, amountPaid)
  const reopened = inv.status === 'paid' && amountDue > 0
  return { payments, amountPaid, amountDue, status: reopened ? 'sent' : inv.status, reopened }
}

// When money actually came in on an invoice, for revenue reporting.
//
// Recorded payments are counted on their own dates. An invoice paid by card
// before payments were itemised has no entry for it, so whatever a PAID invoice
// has left uncovered by amountPaid is counted on its paidAt date. A deposit
// credited onto a final invoice is not counted again here: it is already income
// on the deposit invoice it was paid on.
export function collectedEvents(inv: InvoiceMoney): { amount: number; atMs: number; method: PaymentMethod | 'unknown' }[] {
  const out: { amount: number; atMs: number; method: PaymentMethod | 'unknown' }[] = []
  for (const p of inv.payments || []) {
    const atMs = new Date(`${p.date}T12:00:00`).getTime()
    if (p.amount > 0 && Number.isFinite(atMs)) out.push({ amount: money(p.amount), atMs, method: p.method })
  }
  if (inv.status === 'paid' && inv.paidAt) {
    const rest = money((inv.subtotal || 0) - (inv.amountPaid || 0))
    const atMs = new Date(inv.paidAt).getTime()
    if (rest > 0 && Number.isFinite(atMs)) out.push({ amount: rest, atMs, method: 'unknown' })
  }
  return out
}

export function collectedBetween(invoices: InvoiceMoney[], fromMs: number, toMs: number = Infinity): number {
  let sum = 0
  for (const inv of invoices) for (const ev of collectedEvents(inv)) if (ev.atMs >= fromMs && ev.atMs < toMs) sum += ev.amount
  return money(sum)
}

// What the customer has paid on this invoice in total, for "Paid $X" labels.
export const paidOnInvoice = (inv: InvoiceMoney): number =>
  inv.status === 'paid' ? money(inv.subtotal) : money(inv.amountPaid || 0)

export const isOverdue = (inv: Pick<Invoice, 'status' | 'dueDate' | 'amountDue'>, nowMs: number): boolean =>
  inv.status !== 'paid' && (inv.amountDue || 0) > 0 && !!inv.dueDate && new Date(inv.dueDate).getTime() < nowMs

// ── Numbering ────────────────────────────────────────────────────────────────

// Next INV-YYYY-NNNN for this contractor: one past the HIGHEST number already
// used this year. Counting invoices instead reuses a number as soon as one is
// deleted, and two invoices with the same number is a bookkeeping problem.
export function nextInvoiceNumberFrom(existingNumbers: (string | undefined)[], year: number = new Date().getFullYear()): string {
  let max = 0
  for (const n of existingNumbers) {
    const m = /^INV-(\d{4})-(\d+)$/.exec(n || '')
    if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]))
  }
  return `INV-${year}-${String(max + 1).padStart(4, '0')}`
}

// ── Dates ────────────────────────────────────────────────────────────────────

// yyyy-mm-dd in the device's own timezone. toISOString() gives the UTC date,
// which is already "tomorrow" every evening in the US, so reminders and
// "starts today" were a day off after about 7pm Eastern.
export function localDateStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
