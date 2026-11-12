// Estimates saved before estimate privacy, as they sit in production today:
// an AI quote stored exactly as the AI wrote it (private notes, markup, cost
// prices) and the contractor's spoken walkthrough in `description`.
//
// The one-time cleaning (scripts/migrate-estimate-privacy.mjs) must leave the
// customer's page word-for-word the same, keep signed estimates signable and
// readable, and the contractor must still find their notes in the editor.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { read, readAll, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

const rawQuote = {
  customer_summary: 'Replace the back deck boards and railing caps',
  work_scope: 'Remove 240 sq ft of decking, install new pressure-treated boards and caps.',
  material_list: [
    { name: 'PT deck board 5/4x6x12', base_quantity: 40, waste_percent: 10, quantity_with_waste: 44, quantity_math: '240 sq ft / 6 + 10%', unit: 'each', unit_price: 10, line_total: 440 },
    { name: 'Deck screws 5 lb', base_quantity: 3, waste_percent: 0, quantity_with_waste: 3, quantity_math: '', unit: 'box', unit_price: 20, line_total: 60 },
  ],
  labor: { estimated_hours: 10, breakdown: 'Tear-out, haul-off and install', hourly_rate: 60, labor_total: 600 },
  price_breakdown: { labor_subtotal: 600, materials_subtotal: 500, rentals_subtotal: 0, raw_cost: 1100 },
  profit_markup: { markup_percent: 18.5, markup_dollars: 203.5, rationale: 'Customer seems flexible on price' },
  final_customer_quote: 1303.5,
  contractor_notes: 'PRIVATE: soft joists by the slider, check before sending',
}
const legacy = (extra: Record<string, unknown> = {}) => ({
  createdBy: UID, customerName: 'Pat Doe', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote',
  description: 'WALKTHROUGH: she wants it cheap, I would charge more',
  rateType: 'hourly', hourlyRate: 60, estimatedHours: 10, laborTotal: 600, materials: [], materialsTotal: 500,
  rentals: [], rentalsTotal: 0, jobLocationZip: '27573', jobLocationRegion: 'NC', regionMultiplier: 1, total: 1303.5,
  scopeOfWork: `SCOPE OF WORK\n\nCLIENT: Pat Doe\n\nSUMMARY:\n${rawQuote.customer_summary}\n\n${rawQuote.work_scope}`,
  aiQuote: rawQuote, status: 'pending', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  projectAutoCreated: true, projectId: '',
  ...extra,
})

const migrate = () => execFileSync('node',
  ['--experimental-strip-types', '--no-warnings', 'scripts/migrate-estimate-privacy.mjs',
    '--project', 'demo-setaside', '--write', '--backup-dir', mkdtempSync(join(tmpdir(), 'bp-e2e-backup-'))],
  { env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8380' }, encoding: 'utf8' })

// The page draws the total first and the business card when it arrives; read
// the text only once both are on screen.
const pageText = async (p: Page) => {
  await expect(p.getByText('$1303.50').first()).toBeVisible({ timeout: 20_000 })
  await expect(p.getByText('Tester Builds LLC').first()).toBeVisible({ timeout: 20_000 })
  return (await p.locator('body').innerText()).replace(/\s+/g, ' ').trim()
}

test.beforeEach(async () => {
  await resetData()
  await seedContractor()
  await seed(`publicProfiles/${UID}`, { businessName: 'Tester Builds LLC', businessPhone: '919-555-0100', businessEmail: 'office@example.test', licenseNumber: 'NC-12345', logoUrl: '', cardPaymentsEnabled: false, updatedAt: new Date().toISOString() })
})

test('cleaning an older AI estimate changes nothing on the customer\'s page, and they can still sign', async ({ browser }) => {
  test.slow()
  await seed('estimates/old1', legacy())
  await seed('estimates/signed1', legacy({
    status: 'approved', customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date(Date.now() - 86400000).toISOString() },
    // Signed before the retention clock existed (one production estimate is like this).
  }))

  const visitor = await browser.newContext()
  const link = await visitor.newPage()
  const errors = trackErrors(link)

  const before: Record<string, string> = {}
  for (const id of ['old1', 'signed1']) {
    await link.goto(`/q/${id}`)
    before[id] = await pageText(link)
    // The page never drew the private parts...
    expect(before[id]).not.toMatch(/PRIVATE|WALKTHROUGH|flexible on price|18\.5%/)
  }
  // ...but the document a link holder can read carried them.
  expect(JSON.stringify(await read('estimates/old1'))).toMatch(/PRIVATE|WALKTHROUGH/)

  const out = migrate()
  expect(out).toContain('To clean: 2 (signed 1, pending 1')

  for (const id of ['old1', 'signed1']) {
    await link.goto(`/q/${id}`)
    expect(await pageText(link), id).toBe(before[id])
    const stored = JSON.stringify(await read(`estimates/${id}`))
    expect(stored, id).not.toMatch(/PRIVATE|WALKTHROUGH|flexible on price/)
  }
  expect(await read('estimates/signed1')).toMatchObject({ status: 'approved', total: 1303.5 })

  // The customer can still accept the pending one, at the same price.
  await link.goto('/q/old1')
  await link.getByPlaceholder('Type your full name here').fill('Pat Doe')
  await link.getByRole('button', { name: /Accept Proposal/ }).click()
  await expect(link.getByRole('heading', { name: 'Proposal Accepted' })).toBeVisible()
  expect(await read('estimates/old1')).toMatchObject({ status: 'approved', total: 1303.5 })
  await visitor.close()
  expect(errors).toEqual([])
})

test('after cleaning, the contractor still sees and edits their private notes, and they stay private', async ({ page }) => {
  test.slow()
  await seed('estimates/old1', legacy())
  migrate()
  expect(await read('estimatePrivate/old1')).toMatchObject({ createdBy: UID, contractorNotes: rawQuote.contractor_notes })

  const errors = trackErrors(page)
  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Estimates' }).click()
  await page.getByRole('button', { name: '✏️ Edit' }).click()

  const notes = page.locator('label', { hasText: 'Contractor Notes' }).locator('xpath=following-sibling::textarea')
  await expect(notes).toHaveValue(rawQuote.contractor_notes)
  // Loading the notes is not an unsaved edit.
  await expect(page.getByRole('button', { name: '✓ Up to date' })).toBeVisible()

  await notes.fill('Sistered two joists by the slider')
  await page.getByRole('button', { name: '💾 Save Changes' }).click()
  await expect(page.getByText('✓ Saved')).toBeVisible()

  await expect.poll(async () => (await read('estimatePrivate/old1'))?.contractorNotes, { timeout: 10_000 }).toBe('Sistered two joists by the slider')
  const shared = await read('estimates/old1')
  expect(JSON.stringify(shared)).not.toMatch(/Sistered|PRIVATE|WALKTHROUGH/)
  expect(shared).toMatchObject({ total: 1303.5 })
  expect(errors).toEqual([])
})

test('duplicating an older estimate makes a customer-safe copy and keeps the notes private', async ({ page }) => {
  test.slow()
  // Not cleaned yet, and the contractor has also saved a newer note privately.
  await seed('estimates/old1', legacy())
  await seed('estimatePrivate/old1', { createdBy: UID, contractorNotes: 'Newer note saved in the app' })

  const errors = trackErrors(page)
  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Estimates' }).click()
  await page.getByRole('button', { name: '📄 Duplicate' }).click()

  const notes = page.locator('label', { hasText: 'Contractor Notes' }).locator('xpath=following-sibling::textarea')
  await expect(notes).toHaveValue('Newer note saved in the app')

  const all = await readAll('estimates')
  const copy = all.find(e => e.id !== 'old1')!
  expect(copy).toMatchObject({ total: 1303.5, status: 'pending', createdBy: UID })
  expect(JSON.stringify(copy)).not.toMatch(/PRIVATE|WALKTHROUGH|flexible on price/)
  expect(await read(`estimatePrivate/${copy.id}`)).toMatchObject({
    createdBy: UID, contractorNotes: 'Newer note saved in the app', narration: legacy().description,
  })
  expect(errors).toEqual([])
})
