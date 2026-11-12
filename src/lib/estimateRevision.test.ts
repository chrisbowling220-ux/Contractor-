import { describe, expect, it } from 'vitest'
import type { Estimate } from '../data/types'
import { bindingVersions, isSignedEstimate, revisionFields } from './estimateRevision'

const signed = {
  id: 'e1', customerName: 'Pat Doe', jobTypeName: 'Bathroom remodel', total: 8400, status: 'approved',
  depositRequested: true, depositAmount: 2000, depositInvoiceCreated: true,
  customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: '2026-10-01T00:00:00.000Z' },
  signedAtMs: 1790000000000, startDateResponse: { action: 'confirmed', respondedAt: '2026-10-01T00:00:00.000Z' },
  proposal: { greeting: 'Dear Pat,' }, proposalEdited: true,
  projectId: 'est_e1', projectAutoCreated: true, createdAt: '2026-09-28T00:00:00.000Z', createdBy: 'user_1',
} as unknown as Estimate

describe('revising a signed estimate', () => {
  it('only an approved estimate counts as signed', () => {
    expect(isSignedEstimate(signed)).toBe(true)
    expect(isSignedEstimate({ status: 'pending' })).toBe(false)
    expect(isSignedEstimate({ status: 'declined' })).toBe(false)
  })

  it('the revision carries the edits and starts unsigned', () => {
    const r = revisionFields(signed, { total: 9100, customerName: 'Pat Doe' }, 'user_1', '2026-11-12T00:00:00.000Z')
    expect(r).toMatchObject({ total: 9100, jobTypeName: 'Bathroom remodel', status: 'pending', createdAt: '2026-11-12T00:00:00.000Z', createdBy: 'user_1' })
    for (const key of ['id', 'customerResponse', 'signedAtMs', 'startDateResponse', 'supersededBy', 'proposal', 'proposalEdited']) {
      expect(r, key).not.toHaveProperty(key)
    }
  })

  it('the revision is numbered and points back at what it replaces', () => {
    const v2 = revisionFields(signed, {}, 'user_1')
    expect(v2).toMatchObject({ revision: 2, previousVersionId: 'e1', originalEstimateId: 'e1' })
    const v3 = revisionFields({ ...signed, ...v2, id: 'e2', status: 'approved' } as Estimate, {}, 'user_1')
    expect(v3).toMatchObject({ revision: 3, previousVersionId: 'e2', originalEstimateId: 'e1' })
  })

  it('stays on the same job and does not bill the deposit twice', () => {
    expect(revisionFields(signed, {}, 'user_1')).toMatchObject({ projectId: 'est_e1', projectAutoCreated: true, depositInvoiceCreated: true })
  })

  it('never writes undefined (Firestore refuses it)', () => {
    const r = revisionFields({ ...signed, scopeOfWork: undefined } as unknown as Estimate, { notes: undefined }, 'user_1')
    expect(Object.values(r)).not.toContain(undefined)
  })

  it('leaves the signed version untouched', () => {
    revisionFields(signed, { total: 1 }, 'user_1')
    expect(signed).toMatchObject({ total: 8400, status: 'approved', signedAtMs: 1790000000000 })
  })
})

describe('which version binds', () => {
  const v1 = { ...signed, supersededBy: 'e2' } as Estimate
  const v2 = (status: Estimate['status'], extra: Partial<Estimate> = {}) =>
    ({ ...signed, id: 'e2', total: 9100, status, revision: 2, previousVersionId: 'e1', originalEstimateId: 'e1', ...extra }) as Estimate
  const other = { ...signed, id: 'x1', total: 500 } as Estimate

  it('the signed version, while the revision waits for the customer', () => {
    expect(bindingVersions([v1, v2('pending'), other]).map(e => e.id)).toEqual(['e1', 'x1'])
  })
  it('the signed version, when the customer declines the revision', () => {
    expect(bindingVersions([v1, v2('declined')]).map(e => e.id)).toEqual(['e1'])
  })
  it('the revision, once the customer signs it', () => {
    expect(bindingVersions([v2('approved'), v1]).map(e => e.id)).toEqual(['e2'])
  })
  it('the newest signed version in a longer chain', () => {
    const v3 = { ...signed, id: 'e3', status: 'pending', revision: 3, previousVersionId: 'e2', originalEstimateId: 'e1' } as Estimate
    expect(bindingVersions([v1, v2('approved', { supersededBy: 'e3' }), v3]).map(e => e.id)).toEqual(['e2'])
  })
  it('estimates without revisions are untouched', () => {
    const pending = { ...other, id: 'p', status: 'pending' } as Estimate
    expect(bindingVersions([pending, other])).toEqual([pending, other])
  })
})
