import { describe, expect, it } from 'vitest'
import { contactLinks, matchesCustomerSearch } from './customers'
import type { Customer } from './customers'

const pat: Customer = { id: '1', name: 'Pat Doe', phone: '(919) 555-0142', email: 'pat@example.com', address: '12 Oak St, Roxboro NC', notes: 'Gate code 4411', createdAt: '' }

describe('customer contact links', () => {
  it('builds call, text, email and directions links', () => {
    expect(contactLinks(pat)).toEqual({
      call: 'tel:9195550142', text: 'sms:9195550142',
      email: 'mailto:pat%40example.com',
      map: 'https://www.google.com/maps/dir/?api=1&destination=12%20Oak%20St%2C%20Roxboro%20NC',
    })
  })
  it('leaves out anything the record does not have', () => {
    expect(contactLinks({ phone: '', email: '', address: '' })).toEqual({})
    expect(contactLinks({ phone: 'call me', email: 'not-an-email', address: '' })).toEqual({})
    expect(contactLinks({ phone: '+1 919 555 0142', email: '', address: '' }).call).toBe('tel:+19195550142')
  })
})

describe('customer search', () => {
  it('matches name, email, address and notes, any case', () => {
    for (const q of ['pat', 'DOE', 'example.com', 'oak st', 'gate code', '']) expect(matchesCustomerSearch(pat, q)).toBe(true)
    expect(matchesCustomerSearch(pat, 'smith')).toBe(false)
  })
  it('matches a phone number however it is typed', () => {
    for (const q of ['919 555', '9195550142', '555-0142', '(919)']) expect(matchesCustomerSearch(pat, q)).toBe(true)
    expect(matchesCustomerSearch(pat, '704')).toBe(false)
  })
})
