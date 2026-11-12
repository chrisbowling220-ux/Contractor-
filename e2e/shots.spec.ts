// Screenshots of the screens added in this round, for a human look. Saved to
// e2e/.out (not committed). Also checks the double-booking warning end to end.
import { expect, test } from '@playwright/test'
import { overflowsSideways, readAll, resetData, seed, seedContractor, signIn, UID } from './helpers'

test.beforeEach(async ({ page }) => { await resetData(); await seedContractor(); void page })

test('new screens look right and fit the screen', async ({ page }, info) => {
  test.slow() // first-use emulator start plus three screens
  const tag = info.project.name
  await page.goto('/delete-account')
  await expect(page.getByRole('heading', { name: 'Delete Your Account' })).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/delete-account-${tag}.png` })

  await page.goto('/offline.html')
  await expect(page.getByRole('heading', { name: 'No connection' })).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/offline-${tag}.png` })

  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Delete my account…' }).click()
  await page.getByLabel('Type DELETE to confirm').scrollIntoViewIfNeeded()
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/settings-delete-${tag}.png` })
})

test('the schedule warns about a double booking and lets the contractor decide', async ({ page }) => {
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await seed('calendarEvents/ev1', { createdBy: UID, date, title: 'Miller bathroom', kind: 'job', time: '09:00', createdAt: new Date().toISOString() })

  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Schedule' }).click()
  await page.getByText('Miller bathroom').first().click()

  const messages: string[] = []
  let answer = false
  page.on('dialog', d => { messages.push(d.message()); void (answer ? d.accept() : d.dismiss()) })

  await page.getByPlaceholder(/title|what/i).first().fill('Supplier pickup')
  await page.locator('input[type=time]').first().fill('09:00')
  const save = page.getByRole('button', { name: /^(Add|Save)/ }).first()
  await save.click()
  await expect.poll(() => messages.length).toBe(1)
  expect(messages[0]).toContain('"Miller bathroom" is also at 9:00 AM')
  // Declined: nothing saved.
  expect(await readAll('calendarEvents')).toHaveLength(1)

  answer = true
  await save.click()
  await expect.poll(async () => (await readAll('calendarEvents')).length).toBe(2)
})
