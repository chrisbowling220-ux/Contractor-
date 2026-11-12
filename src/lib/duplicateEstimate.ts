import type { Estimate } from '../data/types'

// Fields for a fresh copy of an estimate ("same as the last bathroom").
//
// Everything about the customer's answer to the ORIGINAL is left behind: the
// signature and its date (the date is what locks a signed estimate against
// deletion for two years, so a copy that kept it could not be deleted), the
// start-date reply, the project link, and the flag saying a deposit invoice
// was already raised (a copy that kept it would never get its own). A copy is
// a new estimate, not a revision: its revision links are dropped too, or it
// would be billed as a version of the job it was copied from.
export function duplicateEstimateFields(e: Estimate, userId: string, nowIso: string = new Date().toISOString()): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...e }
  for (const key of ['id', 'customerResponse', 'signedAtMs', 'startDateResponse', 'projectAutoCreated', 'projectId', 'depositInvoiceCreated',
    'revision', 'originalEstimateId', 'previousVersionId', 'supersededBy']) {
    delete copy[key]
  }
  return { ...copy, status: 'pending', createdAt: nowIso, createdBy: userId }
}
