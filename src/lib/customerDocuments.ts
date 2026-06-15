import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase'
import type { Estimate, ChangeOrder, Invoice, Project } from '../data/types'
import { PUBLIC_HOST } from './config'

// A unified "legal record" for one customer — every estimate, change order, and
// invoice tied to them, with whether it carries the customer's e-signature. This
// is the paper trail the contractor can pull up, print, or share if a customer
// ever disputes the work or the bill.
export interface CustomerDocument {
  id: string
  kind: 'estimate' | 'change_order' | 'invoice'
  title: string            // e.g. "Estimate — Bathroom remodel"
  amount: number
  createdAt: string
  // e-signature info (estimates & change orders carry the customer's sign-off)
  signed: boolean
  signedName?: string
  signedAt?: string
  signedAction?: 'approved' | 'declined'
  // For invoices: paid status instead of a signature
  status?: string
  // Public share/print link to the live document (shows the signature).
  publicUrl: string
  printUrl?: string        // invoices support ?print=1 auto-print
  // 2-year legal-retention lock. While locked, the document can't be deleted
  // (enforced in Firestore rules). lockedUntil = when it becomes deletable.
  retentionLocked: boolean
  lockedUntil?: string     // human-readable date
}

const TWO_YEARS_MS = 63072000000

// Returns lock info from a signing/payment epoch-ms anchor.
function retentionFrom(anchorMs?: number): { retentionLocked: boolean; lockedUntil?: string } {
  if (!anchorMs || typeof anchorMs !== 'number') return { retentionLocked: false }
  const until = anchorMs + TWO_YEARS_MS
  return { retentionLocked: Date.now() < until, lockedUntil: new Date(until).toLocaleDateString() }
}

function fmt(n: unknown): number { return Number(n) || 0 }

// Gather every document for a customer. Estimates link directly by customerId;
// change orders & invoices link by projectId → project.customerId (with a
// customerName fallback for older records that predate customerId on projects).
export async function fetchCustomerDocuments(
  userId: string,
  customer: { id: string; name: string },
): Promise<CustomerDocument[]> {
  if (!userId) return []

  // Pull this user's projects so we can map project → customer for COs/invoices.
  const projSnap = await getDocs(query(collection(db, 'projects'), where('createdBy', '==', userId)))
  const projects = projSnap.docs.map(d => ({ id: d.id, ...d.data() } as Project))
  // Which projectIds belong to THIS customer (by id, or name as a fallback).
  const myProjectIds = new Set(
    projects
      .filter(p => p.customerId === customer.id || (!p.customerId && p.customerName === customer.name))
      .map(p => p.id),
  )

  const [estSnap, coSnap, invSnap] = await Promise.all([
    getDocs(query(collection(db, 'estimates'), where('createdBy', '==', userId))),
    getDocs(query(collection(db, 'changeOrders'), where('createdBy', '==', userId))),
    getDocs(query(collection(db, 'invoices'), where('createdBy', '==', userId))),
  ])

  const docs: CustomerDocument[] = []

  // ── Estimates (linked by customerId; fallback to name) ──
  estSnap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate)).forEach(e => {
    const mine = e.customerId === customer.id || (!e.customerId && e.customerName === customer.name)
    if (!mine) return
    docs.push({
      id: e.id, kind: 'estimate',
      title: `Estimate — ${e.jobTypeName || 'Job'}`,
      amount: fmt(e.total),
      createdAt: e.createdAt,
      signed: !!e.customerResponse?.signedName,
      signedName: e.customerResponse?.signedName,
      signedAt: e.customerResponse?.respondedAt,
      signedAction: e.customerResponse?.action,
      publicUrl: `${PUBLIC_HOST}/q/${e.id}`,
      ...retentionFrom(e.signedAtMs),
    })
  })

  // ── Change orders (linked via projectId → customer) ──
  coSnap.docs.map(d => ({ id: d.id, ...d.data() } as ChangeOrder)).forEach(co => {
    const mine = myProjectIds.has(co.projectId) || co.customerName === customer.name
    if (!mine) return
    docs.push({
      id: co.id, kind: 'change_order',
      title: `Change Order — ${co.description?.slice(0, 40) || 'Scope change'}`,
      amount: fmt(co.newTotal ?? co.delta),
      createdAt: co.createdAt,
      signed: !!co.customerResponse?.signedName,
      signedName: co.customerResponse?.signedName,
      signedAt: co.customerResponse?.respondedAt,
      signedAction: co.customerResponse?.action,
      publicUrl: `${PUBLIC_HOST}/co/${co.id}`,
      ...retentionFrom(co.signedAtMs),
    })
  })

  // ── Invoices (linked via projectId → customer) ──
  invSnap.docs.map(d => ({ id: d.id, ...d.data() } as Invoice)).forEach(inv => {
    const mine = myProjectIds.has(inv.projectId) || inv.customerName === customer.name
    if (!mine) return
    docs.push({
      id: inv.id, kind: 'invoice',
      title: `Invoice ${inv.invoiceNumber || ''}`.trim(),
      amount: fmt(inv.subtotal),
      createdAt: inv.createdAt,
      signed: false,             // invoices aren't e-signed; status carries proof
      status: inv.status,
      publicUrl: `${PUBLIC_HOST}/inv/${inv.id}`,
      printUrl: `${PUBLIC_HOST}/inv/${inv.id}?print=1`,
      ...retentionFrom(inv.paidAtMs),
    })
  })

  // Newest first.
  docs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return docs
}
