import { describe, expect, it } from 'vitest'
import { confirmMessage, nextStatus, previousStatus, shouldAutoAdvance, statusUpdate } from './projectStatus'

const NOW = '2026-11-18T15:00:00.000Z'
const job = { customerName: 'Pat Doe', jobTypeName: 'Deck repair' }
const noMoney = { signed: false, unpaidInvoice: false, hasInvoice: false }

describe('stepping through stages', () => {
  it('walks Lead to Closed one stage at a time', () => {
    const seen = ['lead' as const]
    let s = nextStatus('lead')
    while (s) { seen.push(s as never); s = nextStatus(s) }
    expect(seen).toEqual(['lead', 'estimated', 'contracted', 'in_progress', 'completed', 'closed'])
  })
  it('has no stage before Lead or after Closed', () => {
    expect(previousStatus('lead')).toBeNull()
    expect(nextStatus('closed')).toBeNull()
    expect(previousStatus('completed')).toBe('in_progress')
  })
})

describe('statusUpdate', () => {
  it('marks a hand-made move so the sweep leaves it alone', () => {
    const u = statusUpdate({}, 'contracted', NOW, true)
    expect(u.set).toEqual({ status: 'contracted', statusSetByHandAt: NOW })
    expect(u.clear).toEqual(['closedAt', 'completedAt'])
  })
  it('does not mark an automatic move as hand-made', () => {
    expect(statusUpdate({ completedAt: NOW }, 'closed', NOW, false).set).toEqual({ status: 'closed', closedAt: NOW })
  })
  it('stamps completion, and closing an unfinished job stamps both', () => {
    expect(statusUpdate({}, 'completed', NOW, true).set.completedAt).toBe(NOW)
    expect(statusUpdate({}, 'completed', NOW, true).clear).toEqual(['closedAt'])
    expect(statusUpdate({}, 'closed', NOW, true).set).toMatchObject({ closedAt: NOW, completedAt: NOW })
  })
  it('keeps the original completion date when a completed job is closed', () => {
    const u = statusUpdate({ completedAt: '2026-11-01T00:00:00.000Z' }, 'closed', NOW, true)
    expect(u.set.completedAt).toBeUndefined()
    expect(u.clear).toEqual([])
  })
  it('re-opening a job drops its completion and closing dates', () => {
    expect(statusUpdate({ completedAt: NOW }, 'in_progress', NOW, true).clear).toEqual(['closedAt', 'completedAt'])
  })
})

describe('shouldAutoAdvance', () => {
  const signedAt = (iso: string) => ({ customerResponse: { action: 'approved' as const, signedName: 'Pat', respondedAt: iso } })
  it('moves a signed job forward when nobody picked a stage by hand', () => {
    expect(shouldAutoAdvance({ status: 'lead' }, signedAt(NOW), 'in_progress')).toBe(true)
  })
  it('never moves a job backward', () => {
    expect(shouldAutoAdvance({ status: 'completed' }, signedAt(NOW), 'in_progress')).toBe(false)
    expect(shouldAutoAdvance({ status: 'in_progress' }, signedAt(NOW), 'in_progress')).toBe(false)
  })
  it('respects a stage picked by hand after the customer signed', () => {
    const p = { status: 'contracted' as const, statusSetByHandAt: '2026-11-18T16:00:00.000Z' }
    expect(shouldAutoAdvance(p, signedAt(NOW), 'in_progress')).toBe(false)
  })
  it('still moves the job when the customer signs after the hand-made pick', () => {
    const p = { status: 'contracted' as const, statusSetByHandAt: '2026-11-18T14:00:00.000Z' }
    expect(shouldAutoAdvance(p, signedAt(NOW), 'in_progress')).toBe(true)
  })
  it('does not move a hand-set job on an estimate with no answer date', () => {
    expect(shouldAutoAdvance({ status: 'lead', statusSetByHandAt: NOW }, {}, 'in_progress')).toBe(false)
  })
})

describe('confirmMessage', () => {
  it('lets a plain step forward through the early stages go without asking', () => {
    expect(confirmMessage({ ...job, status: 'lead' }, 'estimated', noMoney)).toBeNull()
    expect(confirmMessage({ ...job, status: 'contracted' }, 'in_progress', noMoney)).toBeNull()
  })
  it('asks before skipping stages, completing, or closing', () => {
    expect(confirmMessage({ ...job, status: 'lead' }, 'in_progress', noMoney)).toMatch(/ahead to In Progress/)
    expect(confirmMessage({ ...job, status: 'in_progress' }, 'completed', noMoney)).toMatch(/as complete/)
    expect(confirmMessage({ ...job, status: 'completed' }, 'closed', noMoney)).toMatch(/No final invoice/)
    expect(confirmMessage({ ...job, status: 'completed' }, 'closed', { ...noMoney, hasInvoice: true, unpaidInvoice: true })).toMatch(/not paid in full/)
  })
  it('asks before going back, and says what stays on file', () => {
    const back = confirmMessage({ ...job, status: 'completed' }, 'contracted', { signed: true, hasInvoice: true, unpaidInvoice: false })
    expect(back).toMatch(/back to Contracted/)
    expect(back).toMatch(/signature stays on file/)
    expect(back).toMatch(/invoice itself is kept/)
  })
})
