import type { Estimate } from '../data/types'

// Signed estimates are never edited. Once a customer approves (e-signs) an
// estimate, that document is the legal record of what they agreed to, and the
// database rules refuse any change to its terms. When the contractor needs to
// change the job, their edits go into a NEW estimate document, a revision,
// which the customer signs in its own right:
//
//   v1 (signed, kept as is)  →  v2 (pending, then signed or declined)  → …
//
// Each revision records the version it replaces (previousVersionId) and the
// first version of the chain (originalEstimateId); the replaced version gets
// supersededBy pointing at its successor, so old links show the newer one.

// Approved is the only state that carries the customer's signature.
export const isSignedEstimate = (e: Pick<Estimate, 'status'>): boolean => e.status === 'approved'

export const revisionNumber = (e: Pick<Estimate, 'revision'>): number => e.revision || 1

// The id shared by every version of one estimate.
export const estimateChainId = (e: Pick<Estimate, 'id' | 'originalEstimateId'>): string => e.originalEstimateId || e.id

// The only fields the contractor's app may still set on a signed estimate.
// They link the record to its project, deposit invoice and newer revision;
// none of them changes what the customer agreed to. Mirrors firestore.rules.
export const SIGNED_ESTIMATE_BOOKKEEPING_FIELDS = ['projectAutoCreated', 'projectId', 'depositInvoiceCreated', 'supersededBy'] as const

// Fields for the next revision of a signed estimate, with the contractor's
// edits applied.
//
// Left behind: everything that belongs to the customer's answer to the signed
// version (their signature, its date, their start-date reply) and the proposal
// letter, which was written for the old terms and is rewritten for the new
// ones on send. Carried over: the project link and the deposit-invoice flag,
// so the revision stays on the same job and does not raise a second deposit
// invoice for a deposit already billed.
export function revisionFields(
  signed: Estimate,
  edits: Record<string, unknown>,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...signed, ...edits }
  for (const key of ['id', 'customerResponse', 'signedAtMs', 'startDateResponse', 'supersededBy', 'proposal', 'proposalEdited']) {
    delete fields[key]
  }
  // Firestore refuses undefined values.
  for (const [key, value] of Object.entries(fields)) if (value === undefined) delete fields[key]
  return {
    ...fields,
    status: 'pending',
    createdAt: nowIso,
    createdBy: userId,
    revision: revisionNumber(signed) + 1,
    previousVersionId: signed.id,
    originalEstimateId: estimateChainId(signed),
  }
}

// The version of each estimate that currently binds the customer and the
// contractor. For an estimate with revisions that is the newest SIGNED
// version: while a revision is waiting for the customer, or after they decline
// it, the version they signed earlier still stands. Estimates without
// revisions are returned as they are. Order follows the input.
export function bindingVersions<T extends Estimate>(estimates: T[]): T[] {
  const chains = new Map<string, T[]>()
  for (const e of estimates) {
    const id = estimateChainId(e)
    const chain = chains.get(id)
    if (chain) chain.push(e)
    else chains.set(id, [e])
  }
  const keep = new Set<string>()
  for (const versions of chains.values()) {
    if (versions.length === 1) { keep.add(versions[0].id); continue }
    const newestFirst = [...versions].sort((a, b) => revisionNumber(b) - revisionNumber(a))
    keep.add((newestFirst.find(isSignedEstimate) ?? newestFirst[0]).id)
  }
  return estimates.filter(e => keep.has(e.id))
}
