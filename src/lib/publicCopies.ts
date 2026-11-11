// What customers are allowed to see, kept apart from what they are not.
//
// Share pages are opened by people who are not signed in. They used to read the
// contractor's own records directly (the whole users/{id} profile, the whole
// customers/{id} record, and a query over customerPhotos), which meant those
// records had to be world-readable: billing state, Stripe ids, the contractor's
// private notes about a customer, and every photo record in the system.
//
// Instead the contractor's app publishes two small copies holding only what a
// share page shows:
//   publicProfiles/{userId}  business card + "can take cards"
//   photoLogs/{customerId}   customer name, address and the photo list
// and the originals become owner-only.
//
// Everything in this file is pure (no Firebase) so it is unit-tested.

export interface PublicProfile {
  businessName: string
  businessPhone: string
  businessEmail: string
  licenseNumber: string
  logoUrl: string
  cardPaymentsEnabled: boolean
}

export const EMPTY_PUBLIC_PROFILE: PublicProfile = {
  businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '', cardPaymentsEnabled: false,
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// Pick the public fields out of a users/{id} document. Anything not named here
// (tier, stripe ids, subscription state, usage counters) is left behind.
export function publicProfileFrom(userDoc: Record<string, unknown> | undefined | null): PublicProfile {
  const d = userDoc || {}
  return {
    businessName: str(d.businessName, 200),
    businessPhone: str(d.businessPhone, 40),
    businessEmail: str(d.businessEmail, 200),
    licenseNumber: str(d.licenseNumber, 80),
    logoUrl: str(d.logoUrl, 2000),
    cardPaymentsEnabled: d.connectPayoutsEnabled === true,
  }
}

export interface PhotoLogEntry {
  id: string
  photoUrl: string
  caption: string
  createdAt: string
}

export interface PhotoLog {
  createdBy: string
  customerName: string
  address: string
  photos: PhotoLogEntry[]
}

// A Firestore document tops out at 1 MB; an entry is roughly 400 bytes. Keep
// the newest photos if a log ever grows past this.
export const PHOTO_LOG_MAX = 1500

interface PhotoLike { id: string; photoUrl?: string; caption?: string; createdAt?: string }

// The public copy of one customer's photo log: oldest first (it reads as a
// progress log), with only the fields the page shows. No phone, email, notes
// or storage paths.
export function buildPhotoLog(
  userId: string,
  customer: { name?: string; address?: string },
  photos: PhotoLike[],
): PhotoLog {
  const entries = photos
    .filter(p => !!p.photoUrl)
    .map(p => ({
      id: p.id,
      photoUrl: String(p.photoUrl),
      caption: str(p.caption, 1000),
      createdAt: p.createdAt || '',
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    createdBy: userId,
    customerName: str(customer.name, 200) || 'Customer',
    address: str(customer.address, 300),
    photos: entries.slice(-PHOTO_LOG_MAX),
  }
}

// Order-independent comparison, so a copy is rewritten only when it changed.
export function sameContent(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'
  }
  return JSON.stringify(v ?? null)
}
