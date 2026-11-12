// A customer-signed estimate is never overwritten. Editing it saves a new
// revision for the customer to sign; the signed version stays exactly as it
// was, and its link points the customer at the newer one.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { overflowsSideways, read, readAll, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

async function goTo(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()
}

// The editor's field labels sit beside their inputs rather than wrapping them.
const hoursInput = (page: Page) => page.locator('label', { hasText: 'Estimated Hours' }).locator('xpath=following-sibling::input')

const signedAtMs = Date.now() - 86400000
const signedEstimate = {
  createdBy: UID, customerName: 'Pat Doe', jobTypeId: 'manual', jobTypeName: 'Deck repair', description: 'Replace rotted boards',
  rateType: 'hourly', hourlyRate: 70, estimatedHours: 10, laborTotal: 700,
  materials: [{ name: 'Pressure-treated 2x6', quantity: 40, unit: 'each', unitPrice: 12.5, lineTotal: 500 }], materialsTotal: 500, rentals: [], rentalsTotal: 0,
  jobLocationZip: '27573', jobLocationRegion: '', regionMultiplier: 1, total: 1200, scopeOfWork: 'SCOPE OF WORK\nReplace rotted deck boards.',
  status: 'approved', signedAtMs, createdAt: new Date(signedAtMs - 86400000).toISOString(),
  customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date(signedAtMs).toISOString() },
  projectId: 'est_e1', projectAutoCreated: true,
}

test('revising a signed estimate keeps the signed version and creates Revision 2', async ({ page, browser }) => {
  test.slow()
  const errors = trackErrors(page)
  await seed('estimates/e1', signedEstimate)
  await seed('projects/est_e1', { createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', status: 'in_progress', sourceEstimateId: 'e1', estimateTotal: 1200, createdAt: new Date().toISOString() })

  await signIn(page)
  await goTo(page, 'Estimates')
  await page.getByRole('button', { name: /Approved/ }).click()
  await page.getByRole('button', { name: '✏️ Revise' }).click()
  await expect(page.getByRole('note').filter({ hasText: 'Signed by Pat Doe' })).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)

  // Raise the hours from 10 to 12: labor $700 → $840.
  await hoursInput(page).fill('12')
  await page.getByRole('button', { name: '💾 Save as Revision 2' }).click()
  await expect(page.getByText(/Saved as Revision 2/)).toBeVisible()
  await expect(page.getByRole('heading', { name: /Revision 2/ })).toBeVisible()

  const all = await readAll('estimates')
  expect(all).toHaveLength(2)
  const original = (await read('estimates/e1'))!
  const revision = all.find(e => e.id !== 'e1')!
  // The signed version is exactly as the customer signed it.
  expect(original).toMatchObject({ total: 1200, status: 'approved', signedAtMs, supersededBy: revision.id })
  expect(original.customerResponse).toMatchObject({ signedName: 'Pat Doe' })
  // The revision carries the change, waits for the customer, stays on the job.
  expect(revision).toMatchObject({ total: 1340, status: 'pending', revision: 2, previousVersionId: 'e1', originalEstimateId: 'e1', projectId: 'est_e1' })
  expect(revision).not.toHaveProperty('customerResponse')
  expect(revision).not.toHaveProperty('signedAtMs')

  // The customer's old link shows what they signed and points to the revision.
  const customer = await (await browser.newContext()).newPage()
  await customer.goto('/q/e1')
  await expect(customer.getByText('Your contractor has sent a revised version of this estimate.')).toBeVisible()
  await expect(customer.getByText('$1200.00').first()).toBeVisible()
  await customer.getByRole('link', { name: 'View the revised estimate →' }).click()
  await expect(customer.getByText('Revision 2').first()).toBeVisible()
  await expect(customer.getByText('$1340.00').first()).toBeVisible()

  // Back in the app: the signed version is now read-only.
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: '📄 View' }).click()
  await expect(page.getByRole('note').filter({ hasText: 'A newer revision has replaced it' })).toBeVisible()
  await expect(hoursInput(page)).toBeDisabled()
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0)
  expect(errors).toEqual([])
})
