// A job the contractor starts by hand (+ New Project) and runs to the end on
// that ONE project: estimate → customer signs → in progress → complete →
// invoice → part payment → paid. Plus Quick Quote adding its estimate (and its
// photos) to an existing project instead of starting a new one, and a job that
// carries two estimates staying put. Runs against the emulators with the real
// security rules, on a phone and on a desktop screen.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { overflowsSideways, read, readAll, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

async function goTo(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const customer = { createdBy: UID, name: 'Sam Rivers', phone: '(919) 555-0177', email: 'sam@example.test', address: '9 Elm St, Roxboro NC', createdAt: '2026-11-01T12:00:00.000Z' }

test('a job started by hand runs from estimate to paid in full on one project', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const errors = trackErrors(page)
  const dialogs: string[] = []
  // Accept every prompt except the "make another invoice?" one, which this
  // test turns down to prove a second invoice is not made by accident.
  page.on('dialog', d => { dialogs.push(d.message()); if (/already has invoice/.test(d.message())) d.dismiss(); else d.accept() })
  await seed('customers/c1', customer)
  await signIn(page)

  // ── 1. Start the job by hand ──
  await goTo(page, 'Projects')
  await page.getByRole('button', { name: '+ New Project' }).click()
  await page.getByPlaceholder('...or type new').fill('Sam Rivers')
  await page.getByPlaceholder('90210').fill('27573')
  await page.getByPlaceholder('One-line description of the work...').fill('Cedar privacy fence, 120 ft')
  await page.getByPlaceholder('Notes (visible only to you)').fill('Dog in the yard')
  await page.getByRole('button', { name: 'Create Project' }).click()
  await expect.poll(async () => (await readAll('projects')).length).toBe(1)
  const [project] = await readAll('projects')
  expect(project).toMatchObject({ customerId: 'c1', status: 'lead' })

  // ── 2. Its estimate is made from the project and stays on it ──
  await page.getByRole('heading', { name: 'Sam Rivers' }).click()
  await expect(page.getByText('No estimate yet.')).toBeVisible()
  await page.getByRole('button', { name: /Build an estimate by hand for this job/ }).click()
  await expect(page.getByLabel('Customer name')).toHaveValue('Sam Rivers')
  await expect(page.getByLabel('Customer name')).toHaveAttribute('readonly', '')
  await page.getByLabel('Job type / title').fill('Fence install')
  await page.getByLabel('Item name').first().fill('Cedar pickets')
  await page.getByLabel('Quantity').first().fill('100')
  await page.getByLabel('Price each').first().fill('4')
  await page.getByLabel('Hours', { exact: true }).fill('8')
  await page.getByLabel('Rate ($/hr)').fill('75')
  await page.getByRole('button', { name: 'Save Estimate →' }).dblclick()   // a double tap saves once

  await expect.poll(async () => (await readAll('estimates')).length).toBe(1)
  const [estimate] = await readAll('estimates')
  expect(estimate).toMatchObject({ total: 1000, projectId: project.id, customerId: 'c1', status: 'pending' })
  await expect.poll(async () => (await read(`projects/${project.id}`))?.status).toBe('estimated')
  await expect(page.getByRole('heading', { name: 'Edit & Send Estimate' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Estimates \(1\)/ })).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)
  // No second project appeared for the estimate, even after the sweep runs.
  await page.waitForTimeout(1500)
  expect(await readAll('projects')).toHaveLength(1)

  // ── 3. The customer signs on their own phone ──
  const customerCtx = await browser.newContext()
  const customerPage = await customerCtx.newPage()
  await customerPage.goto(`/q/${estimate.id}`)
  await expect(customerPage.getByText('$1000.00').first()).toBeVisible()
  await customerPage.getByPlaceholder('Type your full name here').fill('Sam Rivers')
  await customerPage.getByRole('button', { name: /Accept Proposal/ }).click()
  await expect(customerPage.getByRole('heading', { name: 'Proposal Accepted' })).toBeVisible()

  // ── 4. The same project moved to In Progress by itself, notes kept ──
  await expect.poll(async () => (await read(`projects/${project.id}`))?.status, { timeout: 20_000 }).toBe('in_progress')
  const moved = await read(`projects/${project.id}`)
  expect(moved?.notes).toContain('Dog in the yard')
  expect(moved?.notes).toContain('Customer signed')
  expect(await readAll('projects')).toHaveLength(1)
  await expect(page.getByRole('group', { name: 'Project stage' }).getByRole('button', { name: /In Progress/ })).toHaveAttribute('aria-current', 'step')
  await expect(page.getByText('$1000.00').first()).toBeVisible()   // contract total

  // ── 5. Complete, then invoice the job ──
  await page.getByRole('button', { name: /Mark Job Complete/ }).click()
  await expect(page.getByRole('heading', { name: /Final Invoice/ })).toBeVisible()
  await page.getByRole('button', { name: /Build Invoice/ }).click()
  await page.getByRole('button', { name: /Generate Invoice/ }).click()
  await expect(page.getByRole('heading', { name: /Edit Invoice INV-\d{4}-0001/ })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '← Back to Project', exact: true }).click()
  const [invoice] = await readAll('invoices')
  expect(invoice).toMatchObject({ projectId: project.id, subtotal: 1000, amountDue: 1000, customerEmail: 'sam@example.test' })

  // A second invoice for the same job is only made on purpose.
  await page.getByRole('button', { name: /Build another invoice/ }).click()
  await page.getByRole('button', { name: /Generate Invoice/ }).click()
  expect(dialogs.at(-1)).toMatch(/already has invoice INV-\d{4}-0001/)
  await page.waitForTimeout(500)
  expect(await readAll('invoices')).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()

  // ── 6. Part payment, then the rest: the job closes ──
  await page.getByRole('button', { name: /Record payment/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Amount ($)').fill('400')
  await dialog.getByLabel('How they paid').selectOption('check')
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(dialog.getByRole('status')).toContainText('$600.00 still owed')
  expect(await read(`invoices/${invoice.id}`)).toMatchObject({ amountPaid: 400, amountDue: 600, status: 'sent' })
  expect((await read(`projects/${project.id}`))?.status).toBe('completed')

  await dialog.getByLabel('How they paid').selectOption('cash')
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(dialog.getByRole('status')).toContainText('paid in full')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(async () => (await read(`projects/${project.id}`))?.status).toBe('closed')
  // The nudge to send a thank-you says how it was paid: by hand, not by card.
  await expect(page.getByText(/Sam Rivers is paid in full/)).toBeVisible()
  await expect(page.getByText(/paid by card/)).toHaveCount(0)
  expect(await read(`invoices/${invoice.id}`)).toMatchObject({ amountPaid: 1000, amountDue: 0, status: 'paid' })
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/workflow-closed-${test.info().project.name}.png`, fullPage: true })

  // Everything still hangs off the one project.
  expect(await readAll('projects')).toHaveLength(1)
  expect((await readAll('estimates')).every(e => e.projectId === project.id)).toBe(true)
  expect((await readAll('invoices')).every(i => i.projectId === project.id)).toBe(true)
  await customerCtx.close()
  expect(errors).toEqual([])
})

test('Quick Quote from a project adds its estimate and photos to that project', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = trackErrors(page)
  page.on('dialog', d => d.accept())
  await seed('customers/c1', customer)
  await seed('projects/p1', {
    createdBy: UID, customerName: 'Sam Rivers', customerId: 'c1', jobTypeName: 'Deck repair', jobLocationZip: '27573',
    description: 'Rotten boards', notes: 'Side gate', status: 'lead', createdAt: new Date().toISOString(),
  })
  await signIn(page)
  await goTo(page, 'Projects')
  await page.getByRole('heading', { name: 'Sam Rivers' }).click()
  await page.getByRole('button', { name: /Quick Quote for this job/ }).click()

  // Quick Quote opens on that job, with its customer filled in and fixed.
  await expect(page.getByLabel('Which job is this for?')).toHaveValue('p1')
  await expect(page.getByText('The estimate is added to this project')).toBeVisible()
  await expect(page.getByPlaceholder('e.g. Jane Smith')).toHaveCount(0)
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/quick-quote-for-project-${test.info().project.name}.png` })

  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'deck.png', mimeType: 'image/png', buffer: PNG })
  await page.getByPlaceholder(/Press record above to speak/).fill('Replace six rotten deck boards and two stair treads.')
  await page.getByRole('button', { name: /Generate Instant Estimate/ }).click()
  // The estimator isn't running in the tests: take the "build it myself" path,
  // which saves the quote the same way.
  await page.getByRole('button', { name: /Build it myself instead/ }).first().click()

  await expect.poll(async () => (await readAll('estimates')).length).toBe(1)
  const [estimate] = await readAll('estimates')
  expect(estimate).toMatchObject({ projectId: 'p1', customerId: 'c1', customerName: 'Sam Rivers', jobTypeName: 'Deck repair', status: 'pending' })
  await expect.poll(async () => (await read('projects/p1'))?.status).toBe('estimated')
  // The first upload to a cold storage emulator can take a while.
  await expect.poll(async () => (await readAll('projectPhotos')).map(p => p.projectId), { timeout: 45_000 }).toEqual(['p1'])

  // Closing the editor goes back to that job, not to a new one.
  await expect(page.getByRole('heading', { name: 'Edit & Send Estimate' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sam Rivers', level: 2 })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Estimates \(1\)/ })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await readAll('projects')).toHaveLength(1)
  expect((await read('projects/p1'))?.notes).toBe('Side gate')
  expect(errors).toEqual([])
})

test('Quick Quote from the menu can pick an existing job, or start a new one', async ({ page }) => {
  const errors = trackErrors(page)
  await seed('projects/p1', {
    createdBy: UID, customerName: 'Lee Park', jobTypeName: 'Roof patch', jobLocationZip: '27573',
    description: '', notes: '', status: 'contracted', createdAt: new Date().toISOString(),
  })
  // Finished and filed-away jobs are not offered.
  await seed('projects/p2', { createdBy: UID, customerName: 'Old Job', jobTypeName: 'Paint', status: 'closed', notes: '', createdAt: '2026-01-01T00:00:00.000Z' })
  await seed('projects/p3', { createdBy: UID, customerName: 'Gone Job', jobTypeName: 'Paint', status: 'lead', declined: true, notes: '', createdAt: '2026-01-01T00:00:00.000Z' })
  await signIn(page)
  await goTo(page, 'Quick Quote')
  const picker = page.getByLabel('Which job is this for?')
  await expect(picker).toHaveValue('')
  await expect(picker.locator('option')).toHaveText(['+ New job (makes a new project)', 'Lee Park · Roof patch (Contracted)'])
  await picker.selectOption('p1')

  await page.getByRole('button', { name: /Build Manually/ }).click()
  await expect(page.getByLabel('Customer name')).toHaveValue('Lee Park')
  await expect(page.getByLabel('Job type / title')).toHaveValue('Roof patch')
  await page.getByLabel('Flat labor amount ($)').or(page.getByLabel('Hours', { exact: true })).first().waitFor()
  await page.getByRole('button', { name: 'Flat rate' }).click()
  await page.getByLabel('Flat labor amount ($)').fill('850')
  await page.getByRole('button', { name: 'Save Estimate →' }).click()

  await expect.poll(async () => (await readAll('estimates')).length).toBe(1)
  expect((await readAll('estimates'))[0]).toMatchObject({ projectId: 'p1', total: 850 })
  // A job already past Estimated keeps its stage.
  expect((await read('projects/p1'))?.status).toBe('contracted')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Lee Park', level: 2 })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await readAll('projects')).toHaveLength(3)
  expect(errors).toEqual([])
})

test('a job with a signed estimate and a second open one bills only what was signed, and stays put', async ({ page }) => {
  const errors = trackErrors(page)
  const signedAt = new Date(Date.now() - 86400000).toISOString()
  const base = {
    createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', description: 'Deck', rateType: 'flat',
    materials: [], materialsTotal: 0, rentals: [], rentalsTotal: 0, jobLocationZip: '27573', scopeOfWork: 'Scope',
    projectId: 'p1', projectAutoCreated: true, createdAt: signedAt,
  }
  await seed('projects/p1', {
    createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', jobLocationZip: '27573', description: 'Deck',
    notes: 'Back steps first', status: 'lead', createdAt: signedAt,
  })
  await seed('estimates/a', { ...base, flatAmount: 1200, laborTotal: 1200, total: 1200, status: 'declined', customerResponse: { action: 'declined', signedName: 'Pat Doe', respondedAt: signedAt } })
  await seed('estimates/b', { ...base, flatAmount: 2000, laborTotal: 2000, total: 2000, status: 'approved', signedAtMs: Date.parse(signedAt), customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: signedAt } })
  await seed('estimates/c', { ...base, flatAmount: 450, laborTotal: 450, total: 450, status: 'pending' })
  await signIn(page)

  // The sweep moves the job on once, from the signed estimate, and keeps the notes.
  await expect.poll(async () => (await read('projects/p1'))?.status, { timeout: 20_000 }).toBe('in_progress')
  await page.waitForTimeout(2000)
  const p = await read('projects/p1')
  expect(p?.declined).toBeFalsy()
  expect(p?.notes).toContain('Back steps first')
  expect(await readAll('projects')).toHaveLength(1)

  await goTo(page, 'Projects')
  await page.getByRole('heading', { name: 'Pat Doe' }).click()
  // Contract total is the signed $2,000, not $2,450 with the unsigned quote.
  await expect(page.getByText('Contract Total').locator('xpath=following-sibling::p')).toHaveText('$2000.00')
  expect(errors).toEqual([])
})
