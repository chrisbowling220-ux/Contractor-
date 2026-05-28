import { collection, getDocs, getDoc, query, where, addDoc, doc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'
import type { Estimate, Project, ProjectStatus } from '../data/types'
import { PROJECT_STATUS_ORDER } from '../data/types'

// We've merged Estimates into Projects — every estimate should belong to a
// project, and the project's status should AUTO-ADVANCE based on the customer's
// decision so the contractor never has to manually set "contracted" /
// "in progress". This sweep reconciles both sides:
//
//   1. Estimate has NO project yet  → create one at the right status.
//   2. Estimate already HAS a project (created inline by Quick Quote at "lead")
//      → advance that project's status to match the customer's response.
//
// Status mapping from the customer's decision:
//   approved  → "in_progress"  (skips straight past contracted, per the
//               contractor's request: once signed, the job is a go and moves
//               into the active pipeline automatically).
//   declined  → stays "lead" but flagged declined:true (lands in Declined view).
//   pending   → "lead".
//
// We only ever advance a project FORWARD. If the contractor has already moved
// a project further along (e.g. "completed"), we never knock it back.
//
// Idempotent. Returns counts of estimates whose project was newly created OR
// advanced this sweep, split by approved/declined, so the dashboard can show an
// accurate "a customer decided" notification.

function desiredStatusFor(e: Estimate): { status: ProjectStatus; declined: boolean } {
  const approved = e.status === 'approved' && e.customerResponse?.action === 'approved'
  const declined = e.status === 'declined' && e.customerResponse?.action === 'declined'
  if (approved) return { status: 'in_progress', declined: false }
  if (declined) return { status: 'lead', declined: true }
  return { status: 'lead', declined: false }
}

// Is target strictly further along the pipeline than current?
function isForward(current: ProjectStatus, target: ProjectStatus): boolean {
  return PROJECT_STATUS_ORDER.indexOf(target) > PROJECT_STATUS_ORDER.indexOf(current)
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
  for (const e of all) {
    try {
      const { status: target, declined } = desiredStatusFor(e)

      if (e.projectId) {
        // ── Project already exists — reconcile its status. ──
        const pSnap = await getDoc(doc(db, 'projects', e.projectId))
        if (!pSnap.exists()) {
          // Project was deleted; treat as if none exists and recreate below.
          await createProjectFor(e, userId, target, declined)
          changed.push(e)
          continue
        }
        const proj = pSnap.data() as Project
        const updates: Record<string, unknown> = {}
        let didAdvance = false

        if (isForward(proj.status, target)) {
          updates.status = target
          updates.notes = notesFor(e)
          didAdvance = true
        }
        if (declined && !proj.declined) {
          updates.declined = true
          updates.declinedAt = e.customerResponse?.respondedAt || new Date().toISOString()
          if (e.customerResponse?.reason) updates.declineReason = e.customerResponse.reason
          updates.notes = notesFor(e)
          didAdvance = true
        }
        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'projects', e.projectId), updates)
        }
        if (didAdvance) changed.push(e)
      } else if (!e.projectAutoCreated) {
        // ── No project yet — create one at the right status. ──
        await createProjectFor(e, userId, target, declined)
        changed.push(e)
      }
    } catch (err) {
      console.error('Auto-convert/reconcile failed for estimate', e.id, err)
    }
  }

  const approvedCount = changed.filter(e => e.status === 'approved' && e.customerResponse?.action === 'approved').length
  const declinedCount = changed.filter(e => e.status === 'declined' && e.customerResponse?.action === 'declined').length
  return { created: changed.length, estimates: changed, approvedCount, declinedCount }
}

async function createProjectFor(e: Estimate, userId: string, status: ProjectStatus, declined: boolean): Promise<void> {
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
    return
  }

  const project: Omit<Project, 'id'> = {
    customerName: e.customerName,
    ...(e.customerId ? { customerId: e.customerId } : {}),
    jobTypeName: e.jobTypeName,
    jobLocationZip: e.jobLocationZip || '',
    description: e.description || '',
    status,
    notes: notesFor(e),
    createdAt: new Date().toISOString(),
    createdBy: userId,
    sourceEstimateId: e.id,
    estimateTotal: e.total || 0,
    ...(declined ? {
      declined: true,
      declinedAt: e.customerResponse?.respondedAt || new Date().toISOString(),
      ...(e.customerResponse?.reason ? { declineReason: e.customerResponse.reason } : {}),
    } : {}),
  }
  const ref = await addDoc(collection(db, 'projects'), project)
  await updateDoc(doc(db, 'estimates', e.id), {
    projectAutoCreated: true,
    projectId: ref.id,
  })
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
}
