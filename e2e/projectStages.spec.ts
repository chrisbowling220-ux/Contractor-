// Moving a project through its stages by hand: Lead → Estimated → Contracted →
// In Progress → Completed → Closed, from the project list and from the project
// itself, and the automatic estimate sweep leaving a hand-picked stage alone.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { overflowsSideways, read, resetData, seed, seedContractor, signIn, trackErrors, UID } from './helpers'

test.beforeEach(async () => { await resetData(); await seedContractor() })

async function goTo(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()
}

const stages = (page: Page) => page.getByRole('group', { name: 'Project stage' })
const status = async (id: string) => (await read(`projects/${id}`))?.status

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('click a hand-made project from Lead all the way to Closed, and back', async ({ page }) => {
  const errors = trackErrors(page)
  const dialogs: string[] = []
  page.on('dialog', d => { dialogs.push(d.message()); d.accept() })
  await seed('projects/p1', {
    createdBy: UID, customerName: 'Sam Rivers', jobTypeName: 'Fence install', jobLocationZip: '27573',
    description: 'Cedar privacy fence', notes: 'Dog in the yard', status: 'lead', createdAt: new Date().toISOString(),
  })
  await signIn(page)
  await goTo(page, 'Projects')

  // From the list, one tap moves it on without opening it or asking.
  await page.getByRole('button', { name: /Move to Estimated/ }).click()
  await expect.poll(() => status('p1')).toBe('estimated')
  expect(dialogs).toEqual([])
  // The stage chips count what is in this list.
  await expect(page.getByRole('button', { name: 'Estimated (1)' })).toBeVisible()
  expect(await overflowsSideways(page)).toBe(false)

  // Inside the project: the stage bar marks where it is, and Next moves it on.
  await page.getByRole('heading', { name: 'Sam Rivers' }).click()
  await expect(stages(page).getByRole('button', { name: /Estimated/ })).toHaveAttribute('aria-current', 'step')
  await page.getByRole('button', { name: 'Move to Contracted →' }).click()
  await expect.poll(() => status('p1')).toBe('contracted')
  await page.getByRole('button', { name: 'Move to In Progress →' }).click()
  await expect.poll(() => status('p1')).toBe('in_progress')
  expect(dialogs).toEqual([])
  expect(await overflowsSideways(page)).toBe(false)
  await page.screenshot({ path: `e2e/.out/project-stages-${test.info().project.name}.png` })

  // Completing asks first, then unlocks the final invoice.
  await page.getByRole('button', { name: 'Move to Completed →' }).click()
  await expect.poll(() => status('p1')).toBe('completed')
  expect(dialogs.pop()).toMatch(/as complete/)
  await expect(page.getByRole('heading', { name: /Final Invoice/ })).toBeVisible()
  expect(typeof (await read('projects/p1'))?.completedAt).toBe('string')

  // Closing without an invoice says so before doing it.
  await page.getByRole('button', { name: 'Move to Closed →' }).click()
  await expect.poll(() => status('p1')).toBe('closed')
  expect(dialogs.pop()).toMatch(/No final invoice/)
  // Closed is the last stage: no Next button, only Back (and filing it away).
  await expect(page.getByRole('button', { name: /^Move to .+ →$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '← Move back to Completed' })).toBeVisible()
  await expect(page.getByRole('button', { name: '📦 Move to Completed Jobs' })).toBeVisible()

  // Tap any stage to jump straight back to it. Re-opening clears the dates.
  await stages(page).getByRole('button', { name: /In Progress/ }).click()
  await expect.poll(() => status('p1')).toBe('in_progress')
  expect(dialogs.pop()).toMatch(/back to In Progress/)
  const reopened = await read('projects/p1')
  expect(reopened?.completedAt).toBeUndefined()
  expect(reopened?.closedAt).toBeUndefined()
  expect(reopened?.notes).toBe('Dog in the yard')
  await expect(page.getByRole('heading', { name: /Final Invoice/ })).toHaveCount(0)

  // And one step back with the Back button.
  await page.getByRole('button', { name: '← Move back to Contracted' }).click()
  await expect.poll(() => status('p1')).toBe('contracted')
  expect(errors).toEqual([])
})

test('a stage picked by hand sticks after the customer has signed', async ({ page }) => {
  const errors = trackErrors(page)
  page.on('dialog', d => d.accept())
  const signedAt = new Date(Date.now() - 86400000).toISOString()
  await seed('estimates/e1', {
    createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', description: 'Deck', rateType: 'flat', flatAmount: 1200,
    laborTotal: 1200, materials: [], materialsTotal: 0, rentals: [], rentalsTotal: 0, jobLocationZip: '27573', total: 1200,
    scopeOfWork: 'Scope', status: 'approved', signedAtMs: Date.parse(signedAt), projectId: 'est_e1', projectAutoCreated: true,
    customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: signedAt }, createdAt: signedAt,
  })
  await seed('projects/est_e1', {
    createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', jobLocationZip: '27573', description: 'Deck',
    notes: '', status: 'in_progress', sourceEstimateId: 'e1', estimateTotal: 1200, createdAt: signedAt,
  })
  await signIn(page)
  await goTo(page, 'Projects')
  await page.getByRole('heading', { name: 'Pat Doe' }).click()
  await stages(page).getByRole('button', { name: /Contracted/ }).click()
  await expect.poll(() => status('est_e1')).toBe('contracted')

  // A fresh load runs the estimate sweep, which used to push it straight back.
  await page.reload()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).or(page.getByRole('button', { name: '+ New Project' })).first().waitFor()
  await page.waitForTimeout(3000)
  expect(await status('est_e1')).toBe('contracted')
  expect(errors).toEqual([])
})

test('tapping a job on the schedule opens that job', async ({ page }) => {
  const errors = trackErrors(page)
  await seed('projects/p2', {
    createdBy: UID, customerName: 'Lee Park', jobTypeName: 'Roof patch', jobLocationZip: '27573', description: 'Patch',
    notes: '', status: 'contracted', startDate: today(), createdAt: new Date().toISOString(),
  })
  await signIn(page)
  await goTo(page, 'Schedule')
  await page.getByRole('button', { name: /🔨 Lee Park/ }).first().click()
  await page.getByRole('button', { name: /Lee Park · Roof patch/ }).click()
  await expect(page.getByRole('heading', { name: 'Lee Park', level: 2 })).toBeVisible()
  await expect(stages(page).getByRole('button', { name: /Contracted/ })).toHaveAttribute('aria-current', 'step')
  expect(errors).toEqual([])
})
