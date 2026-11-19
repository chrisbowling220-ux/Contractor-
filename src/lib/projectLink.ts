import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import type { WriteBatch } from 'firebase/firestore'
import { db } from '../firebase'
import type { ProjectStatus } from '../data/types'
import { stageAfterNewEstimate } from './projectStatus'

// The project that belongs to an estimate always has an id derived from the
// estimate's id.
//
// A new quote's project can be created from two places at nearly the same
// moment: the screen that just saved the quote, and the dashboard sweep that
// notices an estimate with no project yet. With random ids each could create
// its own, leaving the contractor with two projects for one job. With a derived
// id both writes land on the same document, so there is only ever one.
export const projectIdForEstimate = (estimateId: string): string => `est_${estimateId}`

// Creates (or re-writes with the same starting values) the project for an
// estimate and links the estimate to it. Returns the project id.
export async function createProjectForEstimate(estimateId: string, project: Record<string, unknown>): Promise<string> {
  const projectId = projectIdForEstimate(estimateId)
  await setDoc(doc(db, 'projects', projectId), project)
  await updateDoc(doc(db, 'estimates', estimateId), { projectAutoCreated: true, projectId })
  return projectId
}

// Quoting for a project the contractor already has (one started with
// + New Project, or a job that needs another quote) instead of making a new
// one. The link goes on the estimate when it is first written, so the sweep
// never sees the estimate unlinked and makes a second project for it.
export const linkToProjectFields = (projectId: string) => ({ projectId, projectAutoCreated: true })

// Adds the project's side of a new estimate to the batch that saves the
// estimate: a job still at Lead moves to Estimated. Reads the project first
// so a job that has moved on since the screen loaded is never moved back.
export async function addNewEstimateToProject(batch: WriteBatch, projectId: string): Promise<void> {
  const snap = await getDoc(doc(db, 'projects', projectId))
  if (!snap.exists()) throw new Error('That project no longer exists. Pick another job or start a new one.')
  const stage = stageAfterNewEstimate(snap.data().status as ProjectStatus)
  if (stage) batch.update(doc(db, 'projects', projectId), { status: stage })
}
