import { readFileSync } from 'node:fs'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, getDocs, collection, setDoc } from 'firebase/firestore'
import type { Page } from '@playwright/test'

export const UID = 'user_e2e_contractor'

let env: RulesTestEnvironment | undefined

// Loads the REAL rules files into the emulators, so the browser is held to the
// same rules production would enforce.
export async function testEnv(): Promise<RulesTestEnvironment> {
  env ??= await initializeTestEnvironment({
    projectId: 'demo-setaside',
    firestore: { host: '127.0.0.1', port: 8380, rules: readFileSync('firestore.rules', 'utf8') },
    storage: { host: '127.0.0.1', port: 9499, rules: readFileSync('storage.rules', 'utf8') },
  })
  return env
}

export async function resetData() {
  const e = await testEnv()
  await e.clearFirestore()
  await e.clearStorage()
}

// Write / read documents the way the server would (rules bypassed).
export async function seed(path: string, data: Record<string, unknown>) {
  const e = await testEnv()
  await e.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data) })
}
export async function read(path: string): Promise<Record<string, unknown> | undefined> {
  const e = await testEnv()
  let out: Record<string, unknown> | undefined
  await e.withSecurityRulesDisabled(async ctx => { out = (await getDoc(doc(ctx.firestore(), path))).data() })
  return out
}
export async function readAll(name: string): Promise<Array<Record<string, unknown> & { id: string }>> {
  const e = await testEnv()
  let out: Array<Record<string, unknown> & { id: string }> = []
  await e.withSecurityRulesDisabled(async ctx => {
    out = (await getDocs(collection(ctx.firestore(), name))).docs.map(d => ({ id: d.id, ...d.data() }))
  })
  return out
}

// A returning contractor: business profile on file, so onboarding is skipped.
export async function seedContractor() {
  await seed(`users/${UID}`, { businessName: 'Tester Builds LLC', businessPhone: '919-555-0100', businessEmail: 'office@example.test', licenseNumber: 'NC-12345', tier: 'free', onboardedAt: '2026-01-01T00:00:00.000Z' })
}

export async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor()
}

// Fails the test on any uncaught page error. Console noise from blocked calls
// to services that don't exist in the test setup is filtered by the caller.
export function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  return errors
}

// True when the page can be scrolled sideways, i.e. something overflows the phone screen.
export async function overflowsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
}
