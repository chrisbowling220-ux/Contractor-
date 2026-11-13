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

// A labor-only quote folds its markup into the hourly rate, rounded to the
// cent: 7 h × $142.86 is $1,000.02, not the $1,000.00 quoted. Editing anything
// else must never move the price; only changing the hours or rate reprices.
test('editing a labor-only estimate never moves its price; the rate shown is the marked-up one', async ({ page }) => {
  test.slow()
  const laborOnly = {
    ...rawQuote, material_list: [],
    labor: { estimated_hours: 7, breakdown: 'Prep and paint', hourly_rate: 119.05, labor_total: 833.33 },
    price_breakdown: { labor_subtotal: 833.33, materials_subtotal: 0, rentals_subtotal: 0, raw_cost: 833.33 },
    profit_markup: { markup_percent: 20, markup_dollars: 166.67, rationale: 'PRIVATE rationale' },
    final_customer_quote: 1000,
  }
  await seed('estimates/labor1', legacy({ aiQuote: laborOnly, hourlyRate: 119.05, estimatedHours: 7, laborTotal: 833.33, materialsTotal: 0, total: 1000 }))

  const errors = trackErrors(page)
  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Estimates' }).click()
  await page.getByRole('button', { name: '✏️ Edit' }).click()

  const field = (name: string) => page.locator('label', { hasText: name }).locator('xpath=following-sibling::*[1]')
  await expect(field('Hourly Rate ($/hr)')).toHaveValue('142.86')
  await expect(field('Labor Total')).toHaveText('$1000.00')

  await field('Customer Summary').fill('Repaint the living room and hall')
  await expect(field('Labor Total')).toHaveText('$1000.00')
  await page.getByRole('button', { name: '💾 Save Changes' }).click()
  await expect(page.getByText('✓ Saved')).toBeVisible()
  const saved = await read('estimates/labor1')
  expect(saved).toMatchObject({ total: 1000, laborTotal: 1000, hourlyRate: 142.86, estimatedHours: 7 })
  expect(saved?.aiQuote).toMatchObject({ final_customer_quote: 1000, labor: { hourly_rate: 142.86, labor_total: 1000 } })
  expect(JSON.stringify(saved)).not.toMatch(/119\.05|833\.33|166\.67|PRIVATE/)

  // Changing the hours reprices as hours × rate; changing them back restores the quote.
  await field('Estimated Hours').fill('8')
  await expect(field('Labor Total')).toHaveText('$1142.88')
  await field('Estimated Hours').fill('7')
  await expect(field('Labor Total')).toHaveText('$1000.00')
  expect(errors).toEqual([])
})

// Signed with the old rounding (unit price rounded, then × quantity): a
// revision starts from exactly the figures the customer signed.
test('revising an older signed estimate starts from the prices it was signed with and leaves it untouched', async ({ page }) => {
  test.slow()
  const flooring = {
    ...rawQuote,
    material_list: [
      { name: 'LVP flooring', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 3.29, line_total: 832.37 },
      { name: 'Underlayment', base_quantity: 230, waste_percent: 10, quantity_with_waste: 253, quantity_math: '', unit: 'sq ft', unit_price: 0.47, line_total: 118.91 },
      { name: 'Transition strips', base_quantity: 3, waste_percent: 0, quantity_with_waste: 3, quantity_math: '', unit: 'each', unit_price: 18.97, line_total: 56.91 },
    ],
    labor: { estimated_hours: 16, breakdown: '', hourly_rate: 65, labor_total: 1040 },
    price_breakdown: { labor_subtotal: 1040, materials_subtotal: 1008.19, rentals_subtotal: 0, raw_cost: 2048.19 },
    profit_markup: { markup_percent: 20.44, markup_dollars: 418.64, rationale: 'PRIVATE rationale' },
    final_customer_quote: 2466.83,
  }
  const signedDoc = legacy({
    aiQuote: flooring, hourlyRate: 65, estimatedHours: 16, laborTotal: 1040, materialsTotal: 1008.19, total: 2466.83,
    status: 'approved', customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date(Date.now() - 86400000).toISOString() },
  })
  await seed('estimates/signed2', signedDoc)

  const errors = trackErrors(page)
  await signIn(page)
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Estimates' }).click()
  await page.getByRole('button', { name: /Approved/ }).click()
  await page.getByRole('button', { name: '✏️ Revise' }).click()

  const field = (name: string) => page.locator('label', { hasText: name }).locator('xpath=following-sibling::*[1]')
  await field('Customer Summary').fill('New floor, revised')
  await page.getByRole('button', { name: '💾 Save as Revision 2' }).click()
  await expect(page.getByText(/Saved as Revision 2/)).toBeVisible()

  const all = await readAll('estimates')
  const rev = all.find(e => e.id !== 'signed2')!
  // Rewording the scope keeps the signed total (the old lines add up to
  // $2,469.04; the customer signed $2,466.83).
  expect(rev).toMatchObject({ total: 2466.83, revision: 2 })
  expect(rev.aiQuote).toMatchObject({ final_customer_quote: 2466.83 })
  expect((rev.aiQuote as { material_list: { unit_price: number; line_total: number }[] }).material_list.map(m => [m.unit_price, m.line_total]))
    .toEqual([[4.66, 1178.98], [0.67, 169.51], [26.85, 80.55]])
  expect(JSON.stringify(rev)).not.toMatch(/PRIVATE|832\.37|418\.64/)
  // The signed version is exactly as it was, apart from the pointer to its revision.
  const { supersededBy, ...rest } = (await read('estimates/signed2'))!
  expect(supersededBy).toBe(rev.id)
  expect(rest).toEqual(signedDoc)
  expect(errors).toEqual([])
})
