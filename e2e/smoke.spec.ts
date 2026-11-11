import { expect, test } from '@playwright/test'
import { resetData, seedContractor, signIn, trackErrors } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

test('signs in and reaches the dashboard', async ({ page }) => {
  const errors = trackErrors(page)
  await signIn(page)
  await expect(page.getByRole('button', { name: /Start a quote/ })).toBeVisible()
  await page.screenshot({ path: 'e2e/.out/dashboard.png', fullPage: true })
  expect(errors).toEqual([])
})
