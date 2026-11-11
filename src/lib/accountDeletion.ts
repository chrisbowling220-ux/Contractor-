import { doc, deleteDoc, onSnapshot, setDoc } from 'firebase/firestore'
import { db } from '../firebase'

// Account deletion REQUESTS. Google Play requires an app with accounts to let
// people ask for their account and data to be deleted, from inside the app and
// from a web page. Nothing is deleted automatically: a request is recorded at
// accountDeletionRequests/{userId} for the owner to act on, because signed
// documents and paid invoices are kept for the legal retention period and an
// active subscription has to be cancelled first.

export interface DeletionRequest {
  status: 'requested'
  requestedAt: string
  note?: string
}

export function watchDeletionRequest(userId: string, cb: (r: DeletionRequest | null) => void): () => void {
  return onSnapshot(
    doc(db, 'accountDeletionRequests', userId),
    snap => cb(snap.exists() ? (snap.data() as DeletionRequest) : null),
    () => cb(null),
  )
}

export async function requestAccountDeletion(userId: string, note: string): Promise<void> {
  const trimmed = note.trim().slice(0, 1000)
  await setDoc(doc(db, 'accountDeletionRequests', userId), {
    status: 'requested',
    requestedAt: new Date().toISOString(),
    ...(trimmed ? { note: trimmed } : {}),
  })
}

export async function cancelAccountDeletion(userId: string): Promise<void> {
  await deleteDoc(doc(db, 'accountDeletionRequests', userId))
}
