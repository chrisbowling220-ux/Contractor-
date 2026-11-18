import type { Estimate, Project, ProjectStatus } from '../data/types'
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_ORDER } from '../data/types'

// Moving a project between stages (Lead → … → Completed → Closed).
//
// Most moves happen by themselves: a customer signing the estimate moves the
// job to In Progress, and paying the final invoice closes it. The contractor
// can also click a project to any stage. These helpers keep the two from
// fighting: once the contractor has picked a stage by hand, a customer decision
// that was already on file can no longer drag it somewhere else.

const rank = (s: ProjectStatus) => PROJECT_STATUS_ORDER.indexOf(s)

export const nextStatus = (s: ProjectStatus): ProjectStatus | null =>
  PROJECT_STATUS_ORDER[rank(s) + 1] ?? null

export const previousStatus = (s: ProjectStatus): ProjectStatus | null =>
  rank(s) > 0 ? PROJECT_STATUS_ORDER[rank(s) - 1] : null

// The fields to write when a project moves to `to`. `clear` lists fields to
// remove (the caller turns them into Firestore deleteField()), so a job that is
// re-opened does not keep a completion or closing date it no longer has.
export function statusUpdate(
  p: Pick<Project, 'completedAt'>,
  to: ProjectStatus,
  nowIso: string,
  byHand: boolean,
): { set: Record<string, string>; clear: string[] } {
  const set: Record<string, string> = { status: to }
  const clear: string[] = []
  if (byHand) set.statusSetByHandAt = nowIso
  if (to === 'completed') set.completedAt = nowIso
  if (to === 'closed') {
    set.closedAt = nowIso
    // A job closed straight from an earlier stage was still finished.
    if (!p.completedAt) set.completedAt = nowIso
  } else {
    clear.push('closedAt')
  }
  if (rank(to) < rank('completed')) clear.push('completedAt')
  return { set, clear }
}

// Should the estimate sweep move this project forward to `target`? Only when
// it is a forward move, and only when the contractor has not picked a stage by
// hand since the customer answered. A customer who signs AFTER the contractor
// set a stage still moves the job along, because that is new news.
export function shouldAutoAdvance(
  project: Pick<Project, 'status' | 'statusSetByHandAt'>,
  estimate: Pick<Estimate, 'customerResponse'>,
  target: ProjectStatus,
): boolean {
  if (rank(target) <= rank(project.status)) return false
  const byHand = project.statusSetByHandAt
  if (!byHand) return true
  const answered = Date.parse(estimate.customerResponse?.respondedAt ?? '')
  if (Number.isNaN(answered)) return false
  return answered > Date.parse(byHand)
}

// What to ask before a hand-made move, or null when the move needs no
// confirmation (a plain one-step-forward click through the early stages).
export function confirmMessage(
  p: Pick<Project, 'status' | 'customerName' | 'jobTypeName'>,
  to: ProjectStatus,
  ctx: { signed: boolean; unpaidInvoice: boolean; hasInvoice: boolean },
): string | null {
  const job = `${p.jobTypeName} job for "${p.customerName}"`
  const toLabel = PROJECT_STATUS_LABEL[to]
  if (rank(to) < rank(p.status)) {
    const signedNote = ctx.signed && rank(to) < rank('in_progress')
      ? ' The customer has already signed the estimate; the signature stays on file.'
      : ''
    const invoiceNote = rank(p.status) >= rank('completed') && rank(to) < rank('completed') && ctx.hasInvoice
      ? ' The Final Invoice section is hidden until the job is marked complete again; the invoice itself is kept.'
      : ''
    return `Move the ${job} back to ${toLabel}?${signedNote}${invoiceNote}`
  }
  if (to === 'completed') {
    return `Mark the ${job} as complete? This moves it to Completed and lets you send the thank-you letter and final invoice.`
  }
  if (to === 'closed') {
    const money = !ctx.hasInvoice
      ? ' No final invoice has been made for it yet.'
      : ctx.unpaidInvoice ? ' Its invoice is not paid in full yet.' : ''
    return `Close the ${job}?${money} Jobs close by themselves once the final invoice is paid.`
  }
  if (rank(to) - rank(p.status) > 1) return `Move the ${job} ahead to ${toLabel}?`
  return null
}
