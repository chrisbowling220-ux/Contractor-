// The whole job, start to finish, as a contractor would do it on a phone:
// customer → estimate → customer signs → job → invoice → part payment → paid →
// dashboard → sign out and back in. Runs against the emulators with the real
// security rules.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { overflowsSideways, read, readAll, resetData, seedContractor, signIn, trackErrors, UID } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

// Open a screen from the menu (a drawer on phones, a sidebar on desktop).
async function goTo(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()
}

test('a job from first contact to paid in full', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const errors = trackErrors(page)
  page.on('dialog', d => d.accept())   // confirm() prompts
  await signIn(page)

  // ── 1. Add a customer, then fix a typo in it ──
  await goTo(page, 'Customers')
  await page.getByRole('button', { name: '+ Add Customer' }).click()
  await page.getByLabel('Full name *').fill('Pat Doe')
  await page.getByLabel('Phone').fill('(919) 555-0142')
  await page.getByLabel('Email').fill('pat@example.test')
  await page.getByLabel('Job address').fill('12 Oak St, Roxboro NC')
  await page.getByRole('button', { name: 'Save customer' }).click()
  await expect(page.getByRole('status')).toContainText('Added Pat Doe')
  await expect(page.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:9195550142')

  await page.getByRole('button', { name: /Edit/ }).click()
  await page.getByLabel('Notes (only you see these)').fill('Gate code 4411')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status')).toContainText('Saved changes to Pat Doe')
  await expect(page.getByRole('button', { name: /Pat Doe/ }).first()).toContainText('Gate code 4411')
  expect(await overflowsSideways(page)).toBe(false)

  // ── 2. Build an estimate by hand: materials + hourly labor ──
  await goTo(page, 'Quick Quote')
  await page.getByRole('button', { name: /Build Manually/ }).click()
  await page.getByLabel('Customer name').fill('Pat Doe')
  await page.getByLabel('Job type / title').fill('Deck repair')
  await page.getByLabel('Job ZIP').fill('27573')
  await page.getByLabel('Item name').first().fill('Pressure-treated 2x6')
  await page.getByLabel('Quantity').first().fill('40')
  await page.getByLabel('Price each').first().fill('12.50')
  await page.getByLabel('Hours', { exact: true }).fill('10')
  await page.getByLabel('Rate ($/hr)').fill('70')
  await page.getByRole('button', { name: /Save/ }).last().click()

  // 40 × 12.50 + 10 × 70 = 1,200.00
  await expect.poll(async () => (await readAll('estimates')).length).toBe(1)
  const [estimate] = await readAll('estimates')
  expect(estimate.total).toBe(1200)
  expect(estimate.createdBy).toBe(UID)
  expect(estimate.status).toBe('pending')
  await expect.poll(async () => (await readAll('projects')).length).toBe(1)

  // The editor opens on the new estimate with its materials and the same total.
  await expect(page.getByRole('heading', { name: 'Edit & Send Estimate' })).toBeVisible()
  await expect(page.locator('input[value="Pressure-treated 2x6"]')).toBeVisible()
  await expect(page.getByText('$1200.00').first()).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  // ── 3. The customer opens the link on their own phone and signs ──
  const customer = await browser.newContext()
  const customerPage = await customer.newPage()
  const customerErrors = trackErrors(customerPage)
  await customerPage.goto(`/q/${estimate.id}`)
  await expect(customerPage.getByText('$1200.00').first()).toBeVisible()
  expect(await overflowsSideways(customerPage)).toBe(false)
  await customerPage.getByPlaceholder('Type your full name here').fill('Pat Doe')
  await customerPage.getByRole('button', { name: /Accept Proposal/ }).click()
  await expect(customerPage.getByRole('heading', { name: 'Proposal Accepted' })).toBeVisible()
  const signed = await read(`estimates/${estimate.id}`)
  expect(signed?.status).toBe('approved')
  expect((signed?.customerResponse as { signedName: string }).signedName).toBe('Pat Doe')
  expect(signed?.total).toBe(1200)
  // After signing there is nothing left to answer, even on a fresh load.
  await customerPage.reload()
  await expect(customerPage.getByRole('heading', { name: 'Proposal Accepted' })).toBeVisible()
  await expect(customerPage.getByRole('button', { name: /Accept Proposal/ })).toHaveCount(0)
  expect(customerErrors).toEqual([])

  // ── 4. Back with the contractor: the job moved to In Progress on its own ──
  await goTo(page, 'Projects')
  await expect.poll(async () => (await readAll('projects'))[0].status, { timeout: 20_000 }).toBe('in_progress')
  await page.getByRole('heading', { name: 'Pat Doe' }).click()
  await expect(page.getByText('$1200.00').first()).toBeVisible()        // contract total
  await page.getByRole('button', { name: /Mark Job Complete/ }).click()
  await expect(page.getByRole('heading', { name: /Final Invoice/ })).toBeVisible()

  // ── 5. Final invoice (the wording service isn't running here, so the app
  //       falls back to its standard wording) ──
  await page.getByRole('button', { name: /Build Invoice/ }).click()
  await page.getByRole('button', { name: /Generate Invoice/ }).click()
  await expect(page.getByRole('heading', { name: /Edit Invoice INV-\d{4}-0001/ })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '← Back to Project', exact: true }).click()
  const [invoice] = await readAll('invoices')
  expect(invoice.subtotal).toBe(1200)                                   // matches what was signed
  expect(invoice.amountDue).toBe(1200)
  expect((invoice.lineItems as { lineTotal: number }[]).reduce((s, l) => s + l.lineTotal, 0)).toBe(1200)

  // ── 6. Record a $500 check, then the rest in cash ──
  await page.getByRole('button', { name: /Record payment/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Amount ($)').fill('5000')
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(dialog.getByRole('alert')).toContainText('more than the $1200.00')   // can't overpay
  await dialog.getByLabel('Amount ($)').fill('500')
  await dialog.getByLabel('How they paid').selectOption('check')
  await dialog.getByLabel('Note (optional)').fill('Check #1042')
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(dialog.getByRole('status')).toContainText('$700.00 still owed')
  await expect(dialog.getByText('Check #1042')).toBeVisible()
  let inv = await read(`invoices/${invoice.id}`)
  expect(inv).toMatchObject({ amountPaid: 500, amountDue: 700, status: 'sent' })

  await dialog.getByLabel('How they paid').selectOption('cash')
  await dialog.getByRole('button', { name: 'Save payment' }).click()      // amount pre-filled with the balance
  await expect(dialog.getByRole('status')).toContainText('paid in full')
  inv = await read(`invoices/${invoice.id}`)
  expect(inv).toMatchObject({ amountPaid: 1200, amountDue: 0, status: 'paid' })
  expect((inv?.payments as unknown[]).length).toBe(2)
  expect(typeof inv?.paidAtMs).toBe('number')
  expect(await overflowsSideways(page)).toBe(false)
  await dialog.getByRole('button', { name: 'Done' }).click()

  // Paying the final invoice closes the completed job.
  await expect.poll(async () => (await readAll('projects'))[0].status).toBe('closed')

  // The customer's copy of the invoice is now a receipt listing both payments.
  await customerPage.goto(`/inv/${invoice.id}`)
  await expect(customerPage.getByText('Paid in full')).toBeVisible()
  await expect(customerPage.getByText(/Payment received · Check/)).toBeVisible()
  await expect(customerPage.getByText(/Payment received · Cash/)).toBeVisible()
  await expect(customerPage.getByRole('button', { name: /Pay Cash/ })).toHaveCount(0)
  await customer.close()

  // ── 7. Dashboard: the money shows up once ──
  await page.getByRole('button', { name: '← Dashboard' }).click()
  await expect(page.getByText('Paid this month')).toBeVisible()
  await expect(page.getByText('$1,200').first()).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)

  // The phone's Back button returns to the previous screen instead of leaving.
  await goTo(page, 'Customers')
  await expect(page).toHaveURL(/#customers$/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible()

  // ── 8. Sign out, sign back in: everything is still there ──
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: /Quote the job before/ })).toBeVisible()
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Customers ›/ })).toContainText('1')

  expect(errors).toEqual([])
})
