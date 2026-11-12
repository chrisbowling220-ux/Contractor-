import { describe, expect, it } from 'vitest'
import { formatTime, scheduleConflicts } from './scheduleConflicts'

const events = [
  { id: 'a', title: 'Miller bathroom', time: '09:00', kind: 'job' as const },
  { id: 'b', title: 'Order tile', time: '09:00', kind: 'reminder' as const },
  { id: 'c', title: 'Supplier call', time: '14:30', kind: 'event' as const },
]

describe('scheduleConflicts', () => {
  it('says nothing for an ordinary busy day', () => {
    expect(scheduleConflicts({ time: '11:00', kind: 'event' }, { events })).toEqual([])
    expect(scheduleConflicts({ kind: 'reminder' }, { events, projects: [{ id: 'p', customerName: 'Pat' }] })).toEqual([])
  })
  it('flags two things at the same time, ignoring reminders', () => {
    expect(scheduleConflicts({ time: '09:00', kind: 'event' }, { events })).toEqual(['"Miller bathroom" is also at 9:00 AM'])
    expect(scheduleConflicts({ time: '14:30', kind: 'event' }, { events })).toEqual(['"Supplier call" is also at 2:30 PM'])
  })
  it('flags a second job on a day that already has one, once', () => {
    expect(scheduleConflicts({ time: '13:00', kind: 'job' }, { events })).toEqual(['Job "Miller bathroom" is already on this day'])
    expect(scheduleConflicts({ time: '09:00', kind: 'job' }, { events })).toEqual(['"Miller bathroom" is also at 9:00 AM'])
    expect(scheduleConflicts({ kind: 'job' }, { projects: [{ id: 'p', customerName: 'Pat Doe', jobTypeName: 'Deck repair' }] }))
      .toEqual(['Pat Doe (Deck repair) starts this day'])
  })
  it('does not flag the entry being edited against itself', () => {
    expect(scheduleConflicts({ time: '09:00', kind: 'job', editingId: 'a' }, { events })).toEqual([])
  })
  it('formats times', () => {
    expect(formatTime('00:05')).toBe('12:05 AM')
    expect(formatTime('12:00')).toBe('12:00 PM')
    expect(formatTime('nonsense')).toBe('nonsense')
  })
})
