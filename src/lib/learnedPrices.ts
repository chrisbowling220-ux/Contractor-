import { doc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import type { AIMaterialLine } from '../data/types'

// "My Prices" learning. When a contractor edits material unit prices in an
// estimate and saves, we remember THEIR price for each item under
// userMaterialPrices/{userId}. Future quotes feed these saved prices to the
// generator so it stops making the contractor re-correct the same items —
// the app personalizes to their real local pricing the more they use it.
//
// Storage shape: userMaterialPrices/{userId} = {
//   prices: { "interior paint (1 gal)": { price: 28.5, unit: "gallon", updatedAt }... }
// }
// Keyed by a normalized material name so it matches across quotes.

export function normalizeMaterialName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Save the user's edited material prices. Only stores items with a real price.
export async function rememberMaterialPrices(userId: string, materials: AIMaterialLine[]): Promise<void> {
  if (!userId || materials.length === 0) return
  const entries: Record<string, { price: number; unit: string; updatedAt: string }> = {}
  const now = new Date().toISOString()
  for (const m of materials) {
    const name = normalizeMaterialName(m.name || '')
    const price = Number(m.unit_price) || 0
    if (!name || price <= 0) continue
    entries[name] = { price, unit: m.unit || 'each', updatedAt: now }
  }
  if (Object.keys(entries).length === 0) return
  try {
    // Merge so we accumulate the user's price book over time.
    await setDoc(doc(db, 'userMaterialPrices', userId), { prices: entries, updatedAt: now }, { merge: true })
  } catch (err) {
    console.warn('Could not save learned prices:', err)
  }
}
