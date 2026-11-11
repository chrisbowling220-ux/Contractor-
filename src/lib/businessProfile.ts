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

export async function fetchBusinessName(userId: string): Promise<string> {
  const p = await fetchBusinessProfile(userId)
  return p.businessName
}
