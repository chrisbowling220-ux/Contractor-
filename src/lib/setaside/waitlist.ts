// 1099 Set-Aside early-access list → Firestore `setaside_waitlist`.
//
// The doc id is the SHA-256 of the trimmed, lowercased email, so a second
// signup with the same address lands on the same doc. firestore.rules allow
// CREATE only (no read/update/delete), so that second write comes back as
// permission-denied — which we treat as "already on the list".
import type { FilingStatus } from './types'

export const WAITLIST_COLLECTION = 'setaside_waitlist'
export const WAITLIST_SOURCE = 'safe-to-spend-calculator'
export const MIN_FILL_MS = 3000

// Mirrors the pattern in firestore.rules.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface WaitlistEntry {
  email: string
  trade: string
  firstName?: string
  filingStatus: FilingStatus
  state: 'nc' | 'none' | 'other'
  annualNetBucket: string
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  const e = email.trim()
  return e.length > 0 && e.length < 254 && EMAIL_RE.test(e)
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const

function utmFrom(search: string): Record<string, string> {
  const params = new URLSearchParams(search)
  const out: Record<string, string> = {}
  for (const k of UTM_KEYS) {
    const v = params.get(k)?.trim()
    if (v) out[k] = v.slice(0, 100)
  }
  return out
}

/** Resolves when the person is on the list (new or already there). */
export async function joinWaitlist(entry: WaitlistEntry, search = window.location.search): Promise<void> {
  const email = entry.email.trim()
  const emailLower = normalizeEmail(email)
  const id = await sha256Hex(emailLower)

  // Firestore loads only when someone actually signs up.
  const { createDoc } = await import('./firestoreWrite')

  const data: Record<string, unknown> = {
    email,
    emailLower,
    trade: entry.trade,
    source: WAITLIST_SOURCE,
    filingStatus: entry.filingStatus,
    state: entry.state,
    annualNetBucket: entry.annualNetBucket,
    ...utmFrom(search),
  }
  const firstName = entry.firstName?.trim()
  if (firstName) data.firstName = firstName.slice(0, 60)

  try {
    await createDoc(WAITLIST_COLLECTION, id, data) // adds createdAt: serverTimestamp()
  } catch (err) {
    // Input already passed the same checks the rules make, so a denial here
    // means the doc exists: they signed up before.
    if ((err as { code?: string }).code === 'permission-denied') return
    throw err
  }
}
