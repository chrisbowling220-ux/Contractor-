import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'

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
