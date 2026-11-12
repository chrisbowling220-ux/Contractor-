// scripts/publish-public-copies.mjs, run against the emulator:
//   npm run test:rules
//
// After the new app is released, this one-time job publishes every
// contractor's customer-safe copies, so the final rules can close the old
// public reads at once. It must publish only public fields, touch nothing
// else, be safe to re-run, print no customer data, and leave share links
// working under the final rules.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore'

const PROJECT = 'demo-buildpro-backfill'
let env: RulesTestEnvironment
const ALICE = 'user_alice'
const BOB = 'user_bob'

async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data) })
}
async function readAll(name: string) {
  let out: Array<Record<string, unknown> & { id: string }> = []
  await env.withSecurityRulesDisabled(async ctx => {
    out = (await getDocs(collection(ctx.firestore(), name))).docs.map(d => ({ id: d.id, ...d.data() }))
  })
  return out
}
const run = (...extra: string[]) => execFileSync('node',
  ['--experimental-strip-types', '--no-warnings', 'scripts/publish-public-copies.mjs', '--project', PROJECT, ...extra],
  { env: process.env, encoding: 'utf8' })

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: readFileSync('firestore.rules', 'utf8') } })
})
beforeEach(async () => {
  await env.clearFirestore()
  await seed(`users/${ALICE}`, { businessName: 'Alice Builds', businessPhone: '919-555-0100', businessEmail: 'a@example.test', licenseNumber: 'NC-1', logoUrl: '', tier: 'pro', stripeCustomerId: 'cus_SECRET', aiQuotesUsed: 7, connectPayoutsEnabled: true })
  await seed(`users/${BOB}`, { businessName: 'Bob Co', businessPhone: 5551234 })   // odd shape: phone saved as a number
  await seed('customers/c1', { createdBy: ALICE, name: 'Pat Doe', address: '1 Main St', phone: '919-555-0199', notes: 'gate code 4411' })
  await seed('customers/c2', { createdBy: ALICE, name: 'No Photos Yet' })
  await seed('customerPhotos/p1', { createdBy: ALICE, customerId: 'c1', photoUrl: 'https://img/1', caption: 'Before', createdAt: '2026-10-01T00:00:00.000Z', storagePath: 'customerPhotos/user_alice/x.jpg' })
  await seed('customerPhotos/p2', { createdBy: ALICE, customerId: 'c1', photoUrl: 'https://img/2', caption: 'After', createdAt: '2026-10-05T00:00:00.000Z' })
  await seed('customerPhotos/p3', { createdBy: BOB, customerId: 'c1', photoUrl: 'https://img/evil' })   // someone else's photo pointed at Alice's customer
  await seed('estimates/e1', { createdBy: ALICE, customerName: 'Pat Doe', status: 'pending', total: 100 })
})
afterAll(async () => { await env.cleanup() })

describe('publishing the customer-safe copies for every contractor', () => {
  it('a dry run reports what it would do and writes nothing', async () => {
    const out = run()
    expect(out).toContain('dry run, nothing written')
    expect(out).toContain('Business cards: 2 to create')
    expect(out).toContain('Photo logs: 1 to create')
    expect(await readAll('publicProfiles')).toHaveLength(0)
    expect(await readAll('photoLogs')).toHaveLength(0)
  })

  it('publishes only public fields', async () => {
    run('--write')
    const profiles = await readAll('publicProfiles')
    expect(profiles.map(p => p.id).sort()).toEqual([ALICE, BOB])
    const alice = profiles.find(p => p.id === ALICE)!
    expect(alice).toMatchObject({ businessName: 'Alice Builds', businessPhone: '919-555-0100', cardPaymentsEnabled: true })
    for (const k of ['tier', 'stripeCustomerId', 'aiQuotesUsed', 'connectPayoutsEnabled']) expect(alice, k).not.toHaveProperty(k)
    expect(profiles.find(p => p.id === BOB)).toMatchObject({ businessName: 'Bob Co', businessPhone: '', cardPaymentsEnabled: false })

    const logs = await readAll('photoLogs')
    expect(logs.map(l => l.id)).toEqual(['c1'])   // only customers with photos
    const log = logs[0] as unknown as { createdBy: string; customerName: string; address: string; photos: Array<Record<string, unknown>> }
    expect(log).toMatchObject({ createdBy: ALICE, customerName: 'Pat Doe', address: '1 Main St' })
    expect(log.photos.map(p => p.photoUrl)).toEqual(['https://img/1', 'https://img/2'])   // oldest first, not Bob's
    expect(JSON.stringify(log)).not.toMatch(/919-555-0199|gate code|storagePath/)
  })

  it('touches nothing else and is safe to run again', async () => {
    run('--write')
    expect(run('--write')).toContain('Business cards: 0 to create, 0 to update, 2 already current.')
    await seed(`users/${ALICE}`, { businessName: 'Alice Builds LLC' })
    expect(run()).toContain('Business cards: 0 to create, 1 to update')
    expect(await readAll('estimates')).toHaveLength(1)
    expect((await readAll('customers')).find(c => c.id === 'c1')).toMatchObject({ phone: '919-555-0199', notes: 'gate code 4411' })
  })

  it('prints counts, never customer or billing data', () => {
    const out = run('--write')
    expect(out).not.toMatch(/Pat Doe|919-555|gate code|cus_SECRET|img\/|user_alice/)
  })

  it('after publishing, share links work under the final rules and the originals are closed', async () => {
    run('--write')
    const anon = env.unauthenticatedContext().firestore()
    await assertSucceeds(getDoc(doc(anon, 'publicProfiles', ALICE)))
    await assertSucceeds(getDoc(doc(anon, 'photoLogs', 'c1')))
    await assertFails(getDoc(doc(anon, 'users', ALICE)))
    await assertFails(getDoc(doc(anon, 'customers', 'c1')))
    await assertFails(getDocs(query(collection(anon, 'customerPhotos'), where('customerId', '==', 'c1'))))
  })
})
