import { describe, expect, it } from 'vitest'
import { buildPhotoLog, publicProfileFrom, sameContent, PHOTO_LOG_MAX } from './publicCopies'

describe('publicProfileFrom', () => {
  it('keeps the business card and drops billing and plan fields', () => {
    const p = publicProfileFrom({
      businessName: ' Alice Builds ', businessPhone: '555-0100', businessEmail: 'a@example.com',
      licenseNumber: 'NC-1', logoUrl: 'https://example.com/logo.png',
      tier: 'pro', stripeCustomerId: 'cus_123', stripeConnectId: 'acct_123',
      subscriptionStatus: 'active', aiQuotesUsed: 9, connectPayoutsEnabled: true,
    })
    expect(p).toEqual({
      businessName: 'Alice Builds', businessPhone: '555-0100', businessEmail: 'a@example.com',
      licenseNumber: 'NC-1', logoUrl: 'https://example.com/logo.png', cardPaymentsEnabled: true,
    })
  })
  it('copes with a missing or half-filled profile', () => {
    expect(publicProfileFrom(undefined).businessName).toBe('')
    expect(publicProfileFrom({ businessName: 42, connectPayoutsEnabled: 'yes' })).toMatchObject({
      businessName: '', cardPaymentsEnabled: false,
    })
  })
})

describe('buildPhotoLog', () => {
  const photos = [
    { id: 'b', photoUrl: 'u2', caption: 'after', createdAt: '2026-11-02T00:00:00Z', storagePath: 'x/y', createdBy: 'u' },
    { id: 'a', photoUrl: 'u1', caption: 'before', createdAt: '2026-11-01T00:00:00Z' },
    { id: 'c', caption: 'no url yet' },
  ]
  it('publishes name, address and photos oldest first, and nothing private', () => {
    const log = buildPhotoLog('user_1', { name: 'Pat Doe', address: '1 Elm St', phone: '555', notes: 'gate code' } as never, photos)
    expect(log.createdBy).toBe('user_1')
    expect(log.customerName).toBe('Pat Doe')
    expect(log.photos.map(p => p.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(log)).not.toMatch(/gate code|555|storagePath|x\/y/)
    expect(Object.keys(log.photos[0]).sort()).toEqual(['caption', 'createdAt', 'id', 'photoUrl'])
  })
  it('keeps the newest photos when a log is enormous', () => {
    const many = Array.from({ length: PHOTO_LOG_MAX + 5 }, (_, i) => ({
      id: 'p' + i, photoUrl: 'u', createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    }))
    const log = buildPhotoLog('u', { name: 'x' }, many)
    expect(log.photos).toHaveLength(PHOTO_LOG_MAX)
    expect(log.photos.at(-1)?.id).toBe('p' + (PHOTO_LOG_MAX + 4))
  })
})

describe('sameContent', () => {
  it('ignores key order but not values', () => {
    expect(sameContent({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true)
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameContent({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
  })
})
