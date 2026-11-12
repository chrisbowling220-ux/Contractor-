// Loads the app once before any test runs, so the dev server's first-load
// work (bundling dependencies) is not charged to whichever test goes first.
import { chromium } from '@playwright/test'

export default async function warmup() {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage()
    for (const path of ['/', '/delete-account']) {
      await page.goto('http://127.0.0.1:5199' + path, { waitUntil: 'load', timeout: 180_000 })
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
    }
  } finally {
    await browser.close()
  }
}
