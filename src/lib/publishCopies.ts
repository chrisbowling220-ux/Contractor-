import { collection, doc, getDoc, getDocs, query, where, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import {
  buildPhotoLog, publicProfileFrom, sameContent, EMPTY_PUBLIC_PROFILE,
  type PhotoLog, type PublicProfile,
} from './publicCopies'

// Firestore side of publicCopies.ts: publishing the copies (contractor's app)
// and reading them (share pages).

// ── Contractor side ─────────────────────────────────────────────────────────

function withoutStamp(d: Record<string, unknown> | undefined): Record<string, unknown> {
  const rest = { ...(d || {}) }
  delete rest.updatedAt
  return rest
}

async function writeIfChanged(path: [string, string], next: object): Promise<boolean> {
  const ref = doc(db, path[0], path[1])
  const snap = await getDoc(ref)
  if (snap.exists() && sameContent(withoutStamp(snap.data()), next)) return false
  await setDoc(ref, { ...next, updatedAt: new Date().toISOString() })
  return true
}

// Keep publicProfiles/{userId} in step with the contractor's profile for as
// long as the app is open. Also catches card payments being switched on by the
// Stripe webhook, since that changes the same document.
export function watchAndPublishProfile(userId: string): () => void {
  let last = ''
  return onSnapshot(
    doc(db, 'users', userId),
    snap => {
      if (!snap.exists()) return
      const next = publicProfileFrom(snap.data())
      const key = JSON.stringify(next)
      if (key === last) return
      last = key
      writeIfChanged(['publicProfiles', userId], next)
        .catch(err => { last = ''; console.warn('Public profile publish failed:', err) })
    },
    err => console.warn('Profile listener failed:', err),
  )
}

interface PhotoDoc { id: string; customerId?: string; photoUrl?: string; caption?: string; createdAt?: string }

// Publish (or refresh) one customer's photo log.
export async function publishPhotoLog(
  userId: string,
  customer: { id: string; name?: string; address?: string },
  photos: PhotoDoc[],
): Promise<void> {
  await writeIfChanged(['photoLogs', customer.id], buildPhotoLog(userId, customer, photos))
}

export async function removePhotoLog(customerId: string): Promise<void> {
  try { await deleteDoc(doc(db, 'photoLogs', customerId)) } catch { /* nothing published, or already gone */ }
}

// Bring every photo log up to date. Runs once when the app opens so links that
// were sent out before photo logs were published separately keep working
// without the contractor having to open each customer.
export async function publishAllPhotoLogs(userId: string): Promise<number> {
  const [photoSnap, custSnap] = await Promise.all([
    getDocs(query(collection(db, 'customerPhotos'), where('createdBy', '==', userId))),
    getDocs(query(collection(db, 'customers'), where('createdBy', '==', userId))),
  ])
  const byCustomer = new Map<string, PhotoDoc[]>()
  for (const d of photoSnap.docs) {
    const p = { id: d.id, ...d.data() } as PhotoDoc
    if (!p.customerId) continue
    const list = byCustomer.get(p.customerId) || []
    list.push(p)
    byCustomer.set(p.customerId, list)
  }
  let written = 0
  for (const c of custSnap.docs) {
    const photos = byCustomer.get(c.id)
    if (!photos) continue
    const data = c.data() as { name?: string; address?: string }
    try {
      if (await writeIfChanged(['photoLogs', c.id], buildPhotoLog(userId, data, photos))) written++
    } catch (err) {
      console.warn('Photo log publish failed for customer', c.id, err)
    }
  }
  return written
}

// ── Share-page side ─────────────────────────────────────────────────────────

// The contractor's business card for a share page. Never throws: a share page
// without branding is still a working share page.
export async function fetchPublicProfile(ownerId: string | undefined): Promise<PublicProfile> {
  if (!ownerId) return EMPTY_PUBLIC_PROFILE
  try {
    const snap = await getDoc(doc(db, 'publicProfiles', ownerId))
    if (snap.exists()) return { ...EMPTY_PUBLIC_PROFILE, ...(snap.data() as Partial<PublicProfile>) }
  } catch { /* fall through */ }
  // Not published yet (the contractor has not opened the app since this was
  // introduced). The old location still answers until the rules close it.
  try {
    const snap = await getDoc(doc(db, 'users', ownerId))
    if (snap.exists()) return publicProfileFrom(snap.data())
  } catch { /* closed: no branding */ }
  return EMPTY_PUBLIC_PROFILE
}

export async function fetchPhotoLog(customerId: string): Promise<PhotoLog | null> {
  const snap = await getDoc(doc(db, 'photoLogs', customerId))
  if (snap.exists()) {
    const d = snap.data() as Partial<PhotoLog>
    return {
      createdBy: d.createdBy || '',
      customerName: d.customerName || 'Customer',
      address: d.address || '',
      photos: Array.isArray(d.photos) ? d.photos : [],
    }
  }
  // Not published yet: the old way, which works until the rules close it.
  try {
    const cSnap = await getDoc(doc(db, 'customers', customerId))
    if (!cSnap.exists()) return null
    const c = cSnap.data() as { name?: string; address?: string; createdBy?: string }
    const pSnap = await getDocs(query(collection(db, 'customerPhotos'), where('customerId', '==', customerId)))
    return buildPhotoLog(c.createdBy || '', c, pSnap.docs.map(d => ({ id: d.id, ...d.data() } as PhotoDoc)))
  } catch {
    return null
  }
}
