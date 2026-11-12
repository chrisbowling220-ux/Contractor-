// Reading and writing estimatePrivate/{estimateId} from the contractor's app.
// What goes in it, and why, is in estimatePrivacy.ts.
import { doc, getDoc, type DocumentReference } from 'firebase/firestore'
import { db } from '../firebase'
import { ESTIMATE_PRIVATE_COLLECTION, type EstimatePrivate } from './estimatePrivacy'

export const estimatePrivateRef = (estimateId: string): DocumentReference =>
  doc(db, ESTIMATE_PRIVATE_COLLECTION, estimateId)

// The private record for one estimate, or null if it has none (or it cannot
// be read). Never throws: the editor falls back to what the estimate holds.
export async function loadEstimatePrivate(estimateId: string): Promise<EstimatePrivate | null> {
  try {
    const snap = await getDoc(estimatePrivateRef(estimateId))
    return snap.exists() ? (snap.data() as EstimatePrivate) : null
  } catch {
    return null
  }
}

// The data to store, with undefined values dropped (Firestore refuses them).
export function estimatePrivateData(
  userId: string,
  fields: Omit<EstimatePrivate, 'createdBy' | 'updatedAt'>,
  nowIso: string = new Date().toISOString(),
): EstimatePrivate {
  const out: Record<string, unknown> = { createdBy: userId, updatedAt: nowIso }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v
  return out as unknown as EstimatePrivate
}
