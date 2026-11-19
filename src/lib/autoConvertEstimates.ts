import { collection, getDocs, getDoc, query, where, doc, updateDoc } from 'firebase/firestore'
import { createProjectForEstimate } from './projectLink'
import { db } from '../firebase'
import type { Estimate, Project, ProjectStatus } from '../data/types'
import { createDepositInvoice, nextInvoiceNumber } from './createInvoice'
import { projectDecision, shouldAutoAdvance, withNote } from './projectStatus'
import { fetchBusinessProfile } from './businessProfile'

// We've merged Estimates into Projects — every estimate should belong to a
// project, and the project's status should AUTO-ADVANCE based on the customer's
// decision so the contractor never has to manually set "contracted" /
// "in progress". This sweep reconciles both sides:
//
//   1. Estimate has NO project yet  → create one at the right status.
//   2. Estimate already HAS a project (created inline by Quick Quote at "lead",
//      or one the contractor started by hand and quoted from)
//      → advance that project's status to match the customer's response. A
//      project with several estimates is decided by all of them together.
//
// Status mapping from the customer's decision:
//   approved  → "in_progress"  (skips straight past contracted, per the
//               contractor's request: once signed, the job is a go and moves
//               into the active pipeline automatically).
//   declined  → stays "lead" but flagged declined:true (lands in Declined view).
//   pending   → "lead".
//
// We only ever advance a project FORWARD. If the contractor has already moved
// a project further along (e.g. "completed"), we never knock it back. And once
// the contractor has picked a stage by hand, a customer answer that was already
// on file no longer moves it (lib/projectStatus.ts shouldAutoAdvance); only a
// newer answer does.
//
// Idempotent. Returns counts of estimates whose project was newly created OR
// advanced this sweep, split by approved/declined, so the dashboard can show an
// accurate "a customer decided" notification.

//
// Revisions (lib/estimateRevision.ts): a version that has been replaced by a
// newer one no longer steers the project, and a customer declining a REVISION
// does not mark the job declined, because the version they signed earlier
// still stands.
function desiredStatusFor(e: Estimate): { status: ProjectStatus; declined: boolean } {
  const approved = e.status === 'approved' && e.customerResponse?.action === 'approved'
  const declined = e.status === 'declined' && e.customerResponse?.action === 'declined' && !e.previousVersionId
  if (approved) return { status: 'in_progress', declined: false }
  if (declined) return { status: 'lead', declined: true }
  return { status: 'lead', declined: false }
}

function notesFor(e: Estimate): string {
  const approved = e.status === 'approved' && e.customerResponse?.action === 'approved'
  const declined = e.status === 'declined' && e.customerResponse?.action === 'declined'
  const when = e.customerResponse?.respondedAt
    ? new Date(e.customerResponse.respondedAt).toLocaleDateString()
    : 'unknown date'
  if (approved) {
    return `Customer signed & approved (${e.customerResponse?.signedName || e.customerName}) on ${when}. Auto-moved to In Progress.`
  }
  if (declined) {
    return `Customer DECLINED${e.customerResponse?.signedName ? ` (${e.customerResponse.signedName})` : ''} on ${when}.${e.customerResponse?.reason ? ` Reason: ${e.customerResponse.reason}` : ''}`
  }
  return `Auto-created from estimate (${e.status}) on ${new Date(e.createdAt).toLocaleDateString()}.`
}

export async function autoConvertApprovedEstimates(userId: string): Promise<{
  created: number
  estimates: Estimate[]
  approvedCount: number
  declinedCount: number
}> {
  if (!userId) return { created: 0, estimates: [], approvedCount: 0, declinedCount: 0 }

  // Every estimate owned by this user.
  const snap = await getDocs(query(
    collection(db, 'estimates'),
    where('createdBy', '==', userId),
  ))
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate))
  if (all.length === 0) return { created: 0, estimates: [], approvedCount: 0, declinedCount: 0 }

  const changed: Estimate[] = []
  const live = all.filter(e => !e.supersededBy)

  // ── 1. Estimates with no project yet: make one at the right stage. ──
  for (const e of live) {
    if (e.projectId || e.projectAutoCreated) continue
    try {
      const { status: target, declined } = desiredStatusFor(e)
      e.projectId = await createProjectFor(e, userId, target, declined)
      changed.push(e)
    } catch (err) {
      console.error('Auto-convert failed for estimate', e.id, err)
    }
  }

  // ── 2. Projects with estimates: set the stage from ALL of the project's
  //    estimates together (lib/projectStatus.ts projectDecision). A job can
  //    carry several, e.g. a quote added to a project started by hand. ──
  const byProject = new Map<string, Estimate[]>()
  for (const e of live) {
    if (!e.projectId) continue
    const list = byProject.get(e.projectId)
    if (list) list.push(e)
    else byProject.set(e.projectId, [e])
  }
  for (const [projectId, ests] of byProject) {
    try {
      const pSnap = await getDoc(doc(db, 'projects', projectId))
      if (!pSnap.exists()) {
        // Project was deleted; make a new one for the job and point all of
        // its estimates at it, so they stay together.
        const [first, ...rest] = [...ests].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
        const { status: target, declined } = desiredStatusFor(first)
        const newId = await createProjectFor(first, userId, target, declined)
        for (const e of rest) {
          await updateDoc(doc(db, 'estimates', e.id), { projectId: newId, projectAutoCreated: true })
          e.projectId = newId
        }
        changed.push(first)
        continue
      }
      const proj = pSnap.data() as Project
      const { target, declined, decider } = projectDecision(ests)
      const updates: Record<string, unknown> = {}
      let didAdvance = false

      if (decider && shouldAutoAdvance(proj, decider, target)) {
        updates.status = target
        updates.notes = withNote(proj.notes, notesFor(decider))
        didAdvance = true
      }
      if (declined && !proj.declined && decider) {
        updates.declined = true
        updates.declinedAt = decider.customerResponse?.respondedAt || new Date().toISOString()
        if (decider.customerResponse?.reason) updates.declineReason = decider.customerResponse.reason
        updates.notes = withNote(proj.notes, notesFor(decider))
        didAdvance = true
      }
      // No longer declined (the contractor adjusted the quote and the customer
      // approved the new version, or another quote on the job is still open):
      // the project leaves the Declined view and rejoins the active pipeline.
      if (!declined && proj.declined) {
        updates.declined = false
        didAdvance = true
      }
      if (Object.keys(updates).length > 0) {
        await updateDoc(doc(db, 'projects', projectId), updates)
      }
      if (didAdvance) changed.push(decider ?? ests[ests.length - 1])
    } catch (err) {
      console.error('Auto-convert/reconcile failed for project', projectId, err)
    }
  }

  // ── 3. Deposit invoice: if an estimate was APPROVED and requested a
  //    deposit, create the deposit invoice once (idempotent via the
  //    depositInvoiceCreated flag, and by looking for one already made for this
  //    estimate, e.g. by the customer's pay button a moment ago). ──
  for (const e of live) {
    const approved = e.status === 'approved' && e.customerResponse?.action === 'approved'
    if (!approved || !e.depositRequested || !((e.depositAmount || 0) > 0) || e.depositInvoiceCreated) continue
    try {
      const eSnap = await getDoc(doc(db, 'estimates', e.id))
      const fresh = eSnap.exists() ? ({ id: e.id, ...eSnap.data() } as Estimate) : e
      if (!fresh.projectId || fresh.depositInvoiceCreated) continue
      const invSnap = await getDocs(query(collection(db, 'invoices'), where('createdBy', '==', userId)))
      const already = invSnap.docs.some(d => d.data().isDeposit === true && d.data().estimateId === e.id)
      if (!already) {
        const profile = await fetchBusinessProfile(userId)
        // Invoice number: one past the highest this user has used this year.
        const usedNumbers = invSnap.docs.map(d => d.data().invoiceNumber as string | undefined)
        await createDepositInvoice({
          userId,
          estimate: fresh,
          project: { id: fresh.projectId },
          profile,
          invoiceNumber: nextInvoiceNumber(usedNumbers),
        })
      }
      await updateDoc(doc(db, 'estimates', e.id), { depositInvoiceCreated: true })
    } catch (depErr) {
      console.error('Deposit invoice creation failed for estimate', e.id, depErr)
    }
  }

  const approvedCount = changed.filter(e => e.status === 'approved' && e.customerResponse?.action === 'approved').length
  const declinedCount = changed.filter(e => e.status === 'declined' && e.customerResponse?.action === 'declined').length
  return { created: changed.length, estimates: changed, approvedCount, declinedCount }
}

async function createProjectFor(e: Estimate, userId: string, status: ProjectStatus, declined: boolean): Promise<string> {
  // Guard against a race with ScanRoom's inline project creation (and any other
  // duplicate sweep): if a project already exists for this estimate, link to it
  // instead of creating a second one.
  const existing = await getDocs(query(
    collection(db, 'projects'),
    where('createdBy', '==', userId),
    where('sourceEstimateId', '==', e.id),
  ))
  if (!existing.empty) {
    const existingId = existing.docs[0].id
    await updateDoc(doc(db, 'estimates', e.id), {
      projectAutoCreated: true,
      projectId: existingId,
    })
    return existingId
  }

  const project: Omit<Project, 'id'> = {
    customerName: e.customerName,
    ...(e.customerId ? { customerId: e.customerId } : {}),
    jobTypeName: e.jobTypeName,
    jobLocationZip: e.jobLocationZip || '',
    // A Quick Quote's walkthrough is kept privately now; the summary stands in.
    description: e.description || e.aiQuote?.customer_summary || '',
    status,
    notes: notesFor(e),
    createdAt: new Date().toISOString(),
    createdBy: userId,
    sourceEstimateId: e.id,
    estimateTotal: e.total || 0,
    // Carry the start date into the project: the customer's confirmed/requested
    // date wins, otherwise the contractor's proposed date.
    ...((e.startDateResponse?.action === 'requested_change' && e.startDateResponse.requestedDate)
      ? { startDate: e.startDateResponse.requestedDate }
      : e.proposedStartDate ? { startDate: e.proposedStartDate } : {}),
    ...(declined ? {
      declined: true,
      declinedAt: e.customerResponse?.respondedAt || new Date().toISOString(),
      ...(e.customerResponse?.reason ? { declineReason: e.customerResponse.reason } : {}),
    } : {}),
  }
  // Same derived id the quote screens use, so a sweep that runs while a quote
  // is still being saved cannot create a second project for it.
  const ref = { id: await createProjectForEstimate(e.id, { ...project }) }
  // Migrate any pending Quick Quote photos tagged only by estimate.
  try {
    const photoSnap = await getDocs(query(
      collection(db, 'projectPhotos'),
      where('createdBy', '==', userId),
      where('estimateId', '==', e.id),
    ))
    for (const pdoc of photoSnap.docs) {
      await updateDoc(doc(db, 'projectPhotos', pdoc.id), { projectId: ref.id })
    }
  } catch (err) {
    console.warn('Photo migration failed for estimate', e.id, err)
  }
  return ref.id
}
