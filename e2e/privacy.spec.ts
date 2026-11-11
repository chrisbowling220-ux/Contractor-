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

test('a contractor can ask for their account to be deleted, and change their mind', async ({ page, browser }) => {
  const errors = trackErrors(page)
  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()

  await page.getByRole('button', { name: 'Delete my account…' }).click()
  const send = page.getByRole('button', { name: 'Request deletion' })
  await expect(send).toBeDisabled()          // nothing happens until DELETE is typed
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByLabel(/Anything we should know/).fill('Retiring')
  await send.click()
  await expect(page.getByText(/Deletion requested on/)).toBeVisible()
  expect(await read(`accountDeletionRequests/${UID}`)).toMatchObject({ status: 'requested', note: 'Retiring' })
  // Nothing was deleted: the profile is still there.
  expect((await read(`users/${UID}`))?.businessName).toBe('Tester Builds LLC')

  await page.getByRole('button', { name: 'Keep my account' }).click()
  await expect(page.getByRole('button', { name: 'Delete my account…' })).toBeVisible()
  expect(await read(`accountDeletionRequests/${UID}`)).toBeUndefined()
  expect(errors).toEqual([])

  // The public instructions page Google Play links to opens signed-out.
  const visitor = await browser.newContext()
  const info = await visitor.newPage()
  await info.goto('/delete-account')
  await expect(info.getByRole('heading', { name: 'Delete Your Account' })).toBeVisible()
  await expect(info.getByText(/within 30 days/)).toBeVisible()
  await visitor.close()
})
