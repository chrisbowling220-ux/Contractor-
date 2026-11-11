import { doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'

// The contractor's public-facing business details, shown on estimates,
// invoices, letters and share pages.
export interface BusinessProfile {
  businessName: string
  businessPhone: string
  businessEmail: string
  licenseNumber: string
  logoUrl: string
}

// Always returns a populated object — empty strings for missing fields.
export async function fetchBusinessProfile(userId: string): Promise<BusinessProfile> {
  const empty: BusinessProfile = { businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '' }
  if (!userId) return empty
  try {
    const snap = await getDoc(doc(db, 'users', userId))
    if (!snap.exists()) return empty
    const d = snap.data() as Partial<BusinessProfile>
    return {
      businessName: d.businessName || '',
      businessPhone: d.businessPhone || '',
      businessEmail: d.businessEmail || '',
      licenseNumber: d.licenseNumber || '',
      logoUrl: d.logoUrl || '',
    }
  } catch {
    return empty
  }
}

// Does this contractor still need first-time setup (no business name on file)?
//
// Unlike fetchBusinessProfile this THROWS when the lookup itself fails. A
// failed read (weak signal on a job site) must not be mistaken for "no
// profile": that sent existing contractors back to the welcome screen, where
// saving would have overwritten their real business details.
export async function needsBusinessSetup(userId: string): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const snap = await getDoc(doc(db, 'users', userId))
      return !String((snap.data() as Partial<BusinessProfile> | undefined)?.businessName || '').trim()
    } catch (err) {
      lastError = err
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
    }
  }
  throw lastError
}

export async function fetchBusinessName(userId: string): Promise<string> {
  const p = await fetchBusinessProfile(userId)
  return p.businessName
}
