// What a customer's photo-log link shows, and what it must not: the page reads
// a published copy, never the contractor's customer record, photo records or
// billing profile (those are owner-only in the rules).
import { expect, test } from '@playwright/test'
import { read, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.beforeEach(async () => { await resetData(); await seedContractor() })

test('a photo-log link sent before the change keeps working, and shows nothing private', async ({ page, browser }) => {
  // A customer and photo exactly as the app stored them before photo logs were
  // published separately: no photoLogs document exists yet.
  await seed('customers/c9', { createdBy: UID, name: 'Lee Park', address: '9 Oak Ave', phone: '919-555-0142', email: 'lee@example.test', notes: 'gate code 4411', createdAt: '2026-10-01T00:00:00.000Z' })
  await seed('customerPhotos/ph1', { createdBy: UID, customerId: 'c9', customerName: 'Lee Park', caption: 'Framing done', photoUrl: PNG_URL, storagePath: `customerPhotos/${UID}/c9/1-a.png`, createdAt: '2026-10-02T00:00:00.000Z' })

  const visitor = await browser.newContext()
  const link = await visitor.newPage()

  // Until the contractor's app has published the log, the page says so plainly
  // instead of reading the private records.
  await link.goto('/log/c9')
  await expect(link.getByText(/not available/i)).toBeVisible()

  // The contractor opens the app: the business card and the log are published.
  const errors = trackErrors(page)
  await signIn(page)
  await expect.poll(async () => (await read('photoLogs/c9'))?.customerName, { timeout: 20_000 }).toBe('Lee Park')
  await expect.poll(async () => (await read(`publicProfiles/${UID}`))?.businessName, { timeout: 20_000 }).toBe('Tester Builds LLC')

  const card = await read(`publicProfiles/${UID}`)
  expect(Object.keys(card!).sort()).toEqual(['businessEmail', 'businessName', 'businessPhone', 'cardPaymentsEnabled', 'licenseNumber', 'logoUrl', 'updatedAt'])
  expect(card!.cardPaymentsEnabled).toBe(false)
  const log = await read('photoLogs/c9')
  expect(JSON.stringify(log)).not.toMatch(/gate code|919-555-0142|lee@example|storagePath/)

  // The customer's link now works, branded, with the photo and its caption.
  await link.reload()
  await expect(link.getByText('Framing done')).toBeVisible()
  await expect(link.getByText(/Lee Park/).first()).toBeVisible()
  await expect(link.getByText('Tester Builds LLC').first()).toBeVisible()
  await expect(link.locator(`img[src="${PNG_URL}"]`)).toBeVisible()
  expect(await link.content()).not.toMatch(/gate code|919-555-0142/)

  await visitor.close()
  expect(errors).toEqual([])
})

test('share pages are still branded from the published business card', async ({ page, browser }) => {
  await seed('estimates/e1', {
    createdBy: UID, customerName: 'Pat Doe', jobTypeId: 'manual', jobTypeName: 'Deck repair', description: 'Replace rotted boards',
    rateType: 'hourly', hourlyRate: 70, estimatedHours: 10, laborTotal: 700, materials: [], materialsTotal: 500, rentals: [], rentalsTotal: 0,
    jobLocationZip: '27573', jobLocationRegion: '', regionMultiplier: 1, total: 1200, scopeOfWork: 'SCOPE OF WORK\nReplace rotted deck boards.',
    status: 'pending', createdAt: new Date().toISOString(),
  })
  await signIn(page)
  await expect.poll(async () => (await read(`publicProfiles/${UID}`))?.businessName, { timeout: 20_000 }).toBe('Tester Builds LLC')

  const visitor = await browser.newContext()
  const link = await visitor.newPage()
  await link.goto('/q/e1')
  await expect(link.getByText('Tester Builds LLC').first()).toBeVisible()
  await expect(link.getByText('NC-12345').first()).toBeVisible()
  await visitor.close()
})
