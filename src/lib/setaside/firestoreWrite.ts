// The only Firestore code the waitlist needs. waitlist.ts imports this module
// lazily, so the calculator page doesn't download Firebase until someone
// actually taps "Get Early Access".
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from '../../firebase'

export async function createDoc(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  await setDoc(doc(db, collection, id), { ...data, createdAt: serverTimestamp() })
}
