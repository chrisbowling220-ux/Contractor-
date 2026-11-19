// A project the contractor deleted stays deleted. Its estimates (signed or
// not), invoices and photos are left exactly as they were: the estimate sweep
// used to bring the project back on the next app load, as a NEW project that
// split the job's records. Shapes taken from the three real cases, with
// made-up data.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { read, readAll, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

async function goTo(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()
}

const signedAt = '2026-06-10T15:00:00.000Z'
const estimate = (extra: Record<string, unknown>) => ({
  createdBy: UID, customerName: 'Pat Doe', jobTypeId: 'manual', jobTypeName: 'Deck repair', description: 'Deck', rateType: 'flat',
  flatAmount: 1200, laborTotal: 1200, materials: [], materialsTotal: 0, rentals: [], rentalsTotal: 0, jobLocationZip: '27573',
  total: 1200, scopeOfWork: 'Scope', createdAt: '2026-06-01T12:00:00.000Z', projectAutoCreated: true, ...extra,
})
const signed = { status: 'approved', signedAtMs: Date.parse(signedAt), customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: signedAt } }

// The sweep's own failures show as console errors.
function sweepErrors(page: Page): string[] {
  const out: string[] = []
  page.on('console', m => { if (m.type() === 'error' && /Auto-convert/.test(m.text())) out.push(m.text()) })
  return out
}

test('estimates whose project was deleted are left alone, and the project stays deleted', async ({ page }) => {
  const errors = trackErrors(page)
  const consoleErrors = sweepErrors(page)
  await seed('customers/c1', { createdBy: UID, name: 'Pat Doe', phone: '', email: '', address: '', createdAt: signedAt })
  // 1: signed; its deleted project still has a photo.
  await seed('estimates/o1', estimate({ ...signed, projectId: 'gone1', customerId: 'c1' }))
  await seed('projectPhotos/ph1', { createdBy: UID, projectId: 'gone1', estimateId: 'o1', photoUrl: 'https://example.test/a.jpg', caption: '', createdAt: signedAt })
  // 2: unsigned with a deposit asked; another project names it as its source.
  await seed('estimates/o2', estimate({ status: 'pending', projectId: 'gone2', depositRequested: true, depositAmount: 300, customerName: 'Lee Park' }))
  await seed('projects/survivor', { createdBy: UID, customerName: 'Lee Park', jobTypeName: 'Deck repair', jobLocationZip: '27573', description: '', notes: 'Kept', status: 'lead', sourceEstimateId: 'o2', createdAt: '2026-09-02T12:00:00.000Z' })
  // 3: signed, deposit invoice made; two invoices still name the deleted project.
  await seed('estimates/o3', estimate({ ...signed, projectId: 'gone3', customerId: 'c1', depositRequested: true, depositAmount: 300, depositInvoiceCreated: true }))
  for (const id of ['i1', 'i2']) {
    await seed(`invoices/${id}`, { createdBy: UID, projectId: 'gone3', customerName: 'Pat Doe', jobTypeName: 'Deck repair', invoiceNumber: `INV-2026-000${id.slice(1)}`, subtotal: 300, amountPaid: 300, amountDue: 0, status: 'paid', lineItems: [], introNote: '', paymentTerms: '', dueDate: signedAt, createdAt: signedAt })
  }
  // And one estimate that never had a project: the sweep still makes one.
  await seed('estimates/fresh', estimate({ status: 'pending', projectAutoCreated: false, customerName: 'Sam Rivers', createdAt: new Date().toISOString() }))

  const before = { estimates: await readAll('estimates'), invoices: await readAll('invoices'), photos: await readAll('projectPhotos') }
  await signIn(page)
  // The sweep runs on load; give it time to finish everything it would do.
  await expect.poll(async () => (await read('projects/est_fresh'))?.status, { timeout: 20_000 }).toBe('lead')
  await page.waitForTimeout(3000)

  // No deleted project came back, and no new one was made for its estimates.
  expect((await readAll('projects')).map(p => p.id).sort()).toEqual(['est_fresh', 'survivor'])
  // Estimates (signatures included), invoices and photos are exactly as they were,
  // apart from the brand-new estimate getting its project link.
  const after = await readAll('estimates')
  for (const id of ['o1', 'o2', 'o3']) expect(after.find(e => e.id === id)).toEqual(before.estimates.find(e => e.id === id))
  expect(after.find(e => e.id === 'fresh')).toMatchObject({ projectId: 'est_fresh', projectAutoCreated: true })
  expect(await readAll('invoices')).toEqual(before.invoices)
  expect(await readAll('projectPhotos')).toEqual(before.photos)
  expect(await read('projects/survivor')).toMatchObject({ notes: 'Kept', status: 'lead' })
  expect(consoleErrors).toEqual([])   // and no error logged for them on every load
  expect(errors).toEqual([])
})

test('deleting a project in the app sticks after a reload', async ({ page }) => {
  const errors = trackErrors(page)
  const consoleErrors = sweepErrors(page)
  page.on('dialog', d => d.accept())
  await seed('projects/p1', { createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', jobLocationZip: '27573', description: 'Deck', notes: '', status: 'contracted', createdAt: signedAt })
  await seed('estimates/e1', estimate({ ...signed, projectId: 'p1' }))
  const estimateBefore = await read('estimates/e1')
  await signIn(page)
  await goTo(page, 'Projects')
  await page.getByRole('heading', { name: 'Pat Doe' }).click()
  await page.getByRole('button', { name: /Delete Project/ }).click()
  await expect.poll(async () => (await readAll('projects')).length).toBe(0)

  // A fresh load runs the sweep again: the project does not come back.
  await page.reload()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).or(page.getByRole('button', { name: '+ New Project' })).first().waitFor()
  await page.waitForTimeout(3000)
  expect(await readAll('projects')).toHaveLength(0)
  // The signed estimate is untouched and still listed with the estimates.
  expect(await read('estimates/e1')).toEqual(estimateBefore)
  await goTo(page, 'Estimates')
  await page.getByRole('button', { name: /Approved/ }).click()
  await expect(page.getByText('Pat Doe').first()).toBeVisible()
  expect(consoleErrors).toEqual([])
  expect(errors).toEqual([])
})
