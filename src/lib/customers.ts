// Customer record helpers shared by the customer list and detail screens.

export interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
  notes?: string
  createdAt: string
  updatedAt?: string
}

// One-tap contact actions for a phone in the field. Only the ones the record
// has data for are returned.
export function contactLinks(c: Pick<Customer, 'phone' | 'email' | 'address'>): { call?: string; text?: string; email?: string; map?: string } {
  const digits = (c.phone || '').replace(/[^\d+]/g, '')
  const hasPhone = digits.replace(/\D/g, '').length >= 7
  const email = (c.email || '').trim()
  const address = (c.address || '').trim()
  return {
    ...(hasPhone ? { call: `tel:${digits}`, text: `sms:${digits}` } : {}),
    ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email: `mailto:${encodeURIComponent(email)}` } : {}),
    // Opens the phone's own maps app on Android and iOS.
    ...(address ? { map: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` } : {}),
  }
}

// Free-text search over everything on the record. Phone numbers match however
// they were typed: "919 555" finds "(919) 555-0142".
export function matchesCustomerSearch(c: Customer, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  const text = [c.name, c.email, c.address, c.notes, c.phone].filter(Boolean).join(' ').toLowerCase()
  if (text.includes(q)) return true
  const qDigits = q.replace(/\D/g, '')
  return qDigits.length >= 3 && (c.phone || '').replace(/\D/g, '').includes(qDigits)
}
