import { describe, expect, it } from 'vitest'
import type { Estimate } from '../data/types'
import { duplicateEstimateFields } from './duplicateEstimate'

describe('duplicating an estimate', () => {
  const signed = {
    id: 'e1', customerName: 'Pat Doe', jobTypeName: 'Bathroom remodel', total: 8400, status: 'approved',
    depositRequested: true, depositAmount: 2000, depositInvoiceCreated: true,
    customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: '2026-10-01T00:00:00.000Z' },
    signedAtMs: 1790000000000, startDateResponse: { action: 'confirmed', respondedAt: '2026-10-01T00:00:00.000Z' },
    projectId: 'p1', projectAutoCreated: true, createdAt: '2026-09-28T00:00:00.000Z', createdBy: 'someone',
  } as unknown as Estimate

  it('keeps the work and the price', () => {
    const copy = duplicateEstimateFields(signed, 'user_1', '2026-11-11T00:00:00.000Z')
    expect(copy).toMatchObject({ customerName: 'Pat Doe', jobTypeName: 'Bathroom remodel', total: 8400, depositRequested: true, depositAmount: 2000 })
    expect(copy).toMatchObject({ status: 'pending', createdBy: 'user_1', createdAt: '2026-11-11T00:00:00.000Z' })
  })
  it('carries nothing over from the original customer answer', () => {
    const copy = duplicateEstimateFields(signed, 'user_1')
    for (const key of ['id', 'customerResponse', 'signedAtMs', 'startDateResponse', 'projectId', 'projectAutoCreated', 'depositInvoiceCreated']) {
      expect(copy, key).not.toHaveProperty(key)
    }
  })
  it('does not change the original', () => {
    duplicateEstimateFields(signed, 'user_1')
    expect(signed.signedAtMs).toBe(1790000000000)
  })
})
