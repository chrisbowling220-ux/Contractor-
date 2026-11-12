// scripts/migrate-estimate-privacy.mjs, run against the emulator:
//   npm run test:rules
//
// Cleans estimates saved before estimate privacy: the private side moves to
// estimatePrivate, the shared estimate keeps the customer view. It must write
// nothing on a dry run, never change what a customer sees (signed estimates
// included), refuse what it cannot read, never overwrite notes the app has
// already saved, print no customer data or share-link ids, take an exact
// backup first, and be able to put everything back from it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import { customerVisibleContent } from '../src/lib/estimatePrivacy'

const PROJECT = 'demo-buildpro-estimate-privacy'
const ALICE = 'user_alice'
let env: RulesTestEnvironment
let backupDir: string

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
const byId = async (name: string) => new Map((await readAll(name)).map(d => [d.id, d]))
const run = (...extra: string[]) => {
  try {
    return execFileSync('node',
      ['--experimental-strip-types', '--no-warnings', 'scripts/migrate-estimate-privacy.mjs', '--project', PROJECT, '--backup-dir', backupDir, ...extra],
      { env: process.env, encoding: 'utf8' })
  } catch (e) {
    // Exit 1 = finished but some estimates were left as they are.
    const err = e as { status?: number; stdout?: string }
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout
    throw e
  }
}

const rawQuote = (extra: Record<string, unknown> = {}) => ({
  customer_summary: 'Replace the back deck boards',
  work_scope: 'Remove and replace 240 sq ft of decking',
  material_list: [
    { name: 'PT board', base_quantity: 40, waste_percent: 10, quantity_with_waste: 44, quantity_math: '40+10%', unit: 'each', unit_price: 10, line_total: 440 },
    { name: 'Screws', base_quantity: 3, waste_percent: 0, quantity_with_waste: 3, quantity_math: '', unit: 'box', unit_price: 20, line_total: 60 },
  ],
  labor: { estimated_hours: 10, breakdown: 'tear-out and install', hourly_rate: 60, labor_total: 600 },
  price_breakdown: { labor_subtotal: 600, materials_subtotal: 500, rentals_subtotal: 0, raw_cost: 1100 },
  profit_markup: { markup_percent: 18.5, markup_dollars: 203.5, rationale: 'Customer seems flexible on price' },
  final_customer_quote: 1303.5,
  contractor_notes: 'SECRET-NOTE soft joists by the door',
  ...extra,
})
const quickQuote = (extra: Record<string, unknown> = {}) => ({
  createdBy: ALICE, customerName: 'Pat Doe', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote',
  description: 'SECRET-WALKTHROUGH she wants it cheap', laborTotal: 600, materialsTotal: 500, rentalsTotal: 0, total: 1303.5,
  aiQuote: rawQuote(), status: 'pending', createdAt: '2026-10-01T12:00:00.000Z', jobLocationZip: '27401',
  ...extra,
})
const signedResponse = { action: 'approved', signedName: 'Pat Doe', respondedAt: '2026-10-02T12:00:00.000Z' }

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: readFileSync('firestore.rules', 'utf8') } })
})
beforeEach(async () => {
  await env.clearFirestore()
  backupDir = mkdtempSync(join(tmpdir(), 'bp-estimate-privacy-'))
  await seed('estimates/pending1', quickQuote())
  await seed('estimates/signed1', quickQuote({ status: 'approved', signedAtMs: 1790000000000, customerResponse: signedResponse, projectId: 'p1', proposal: { greeting: 'Dear Pat' } }))
  await seed('estimates/declined1', quickQuote({ status: 'declined', aiQuote: rawQuote({ profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' }, final_customer_quote: 1100 }), total: 1100 }))
  await seed('estimates/edited1', quickQuote({ description: '', materialsTotal: 703.5, aiQuote: { ...rawQuote(), profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' }, material_list: [], price_breakdown: { labor_subtotal: 600, materials_subtotal: 0, rentals_subtotal: 0, raw_cost: 600 }, final_customer_quote: 600, contractor_notes: 'call first' }, laborTotal: 600, total: 600 }))
  await seed('estimatePrivate/edited1', { createdBy: ALICE, contractorNotes: 'newer note saved by the app' })
  await seed('estimates/manual1', { createdBy: ALICE, customerName: 'Sam Roe', jobTypeId: 'manual', jobTypeName: 'Deck', description: 'Replace boards', total: 900, status: 'pending' })
  await seed('estimates/broken1', { createdBy: ALICE, customerName: 'Lee', jobTypeId: 'quick-quote', aiQuote: { final_customer_quote: 5 }, total: 5, status: 'pending' })
  await seed('estimates/orphan1', quickQuote({ createdBy: null }))
})
afterAll(async () => { await env.cleanup() })

describe('cleaning estimates saved before estimate privacy', () => {
  it('a dry run reports what it would do and writes nothing', async () => {
    const before = await readAll('estimates')
    const out = run()
    expect(out).toContain('dry run, nothing written')
    expect(out).toContain('Read: 7 estimates')
    expect(out).toContain('Already customer-safe: 1.')
    expect(out).toContain('To clean: 4 (signed 1, pending 2, declined 1, other 0).')
    expect(out).toContain('carrying private notes: 4; markup figures: 2; spoken walkthrough: 3; cost-price subtotals: 3.')
    expect(out).toContain('aiQuote is not in the expected shape')
    expect(out).toContain('no owner (createdBy), left as is')
    expect(out).toContain('Private records: 3 to create, 1 to add to.')
    expect(out).toContain('Failures (left exactly as they are): 2.')
    expect(await readAll('estimates')).toEqual(before)
    expect(await readAll('estimatePrivate')).toHaveLength(1)
    expect(readdirSync(backupDir)).toHaveLength(0)
  })

  it('moves the private side out without changing what any customer sees', async () => {
    const before = await byId('estimates')
    run('--write')
    const after = await byId('estimates')
    const priv = await byId('estimatePrivate')

    for (const id of ['pending1', 'signed1', 'declined1', 'edited1']) {
      const a = after.get(id)!
      expect(customerVisibleContent(a), id).toEqual(customerVisibleContent(before.get(id)!))
      const json = JSON.stringify(a)
      expect(json, id).not.toMatch(/SECRET-NOTE|SECRET-WALKTHROUGH|flexible on price|call first/)
      expect((a.aiQuote as { profit_markup: unknown }).profit_markup, id).toEqual({ markup_percent: 0, markup_dollars: 0, rationale: '' })
    }
    // The signed record keeps its signature, date, links and letter.
    expect(after.get('signed1')).toMatchObject({ status: 'approved', signedAtMs: 1790000000000, customerResponse: signedResponse, projectId: 'p1', proposal: { greeting: 'Dear Pat' }, total: 1303.5 })
    // Cost-price subtotal replaced by the customer-view one.
    expect(after.get('pending1')!.materialsTotal).toBe(703.5)

    expect(priv.get('pending1')).toMatchObject({
      createdBy: ALICE, contractorNotes: 'SECRET-NOTE soft joists by the door', narration: 'SECRET-WALKTHROUGH she wants it cheap',
      aiMarkupPercent: 18.5, aiMarkupDollars: 203.5, aiMarkupRationale: 'Customer seems flexible on price', aiCostSubtotal: 1100,
    })
    // A note the app already saved privately is never overwritten.
    expect(priv.get('edited1')!.contractorNotes).toBe('newer note saved by the app')

    // Left exactly as they were.
    for (const id of ['manual1', 'broken1', 'orphan1']) expect(after.get(id), id).toEqual(before.get(id))
    expect(priv.has('broken1') || priv.has('orphan1') || priv.has('manual1')).toBe(false)
  })

  it('is safe to run again', async () => {
    run('--write')
    const second = run('--write')
    expect(second).toContain('To clean: 0')
    expect(second).toContain('Already customer-safe: 5.')
  })

  it('prints counts, never customer data or share-link ids', () => {
    const out = run('--write')
    expect(out).not.toMatch(/Pat Doe|Sam Roe|SECRET|flexible|pending1|signed1|broken1|orphan1|user_alice|1303/)
  })

  it('takes an owner-only backup first, and --restore puts the original fields back exactly', async () => {
    const before = await byId('estimates')
    run('--write')
    const files = readdirSync(backupDir)
    expect(files).toHaveLength(1)
    const file = join(backupDir, files[0])
    expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(run('--restore', file)).toContain('dry run, nothing written')
    run('--restore', file, '--write')
    const restored = await byId('estimates')
    for (const [id, e] of before) expect(restored.get(id), id).toEqual(e)
  })

  it('after cleaning, the share link still opens and the customer can still sign', async () => {
    run('--write')
    const anon = env.unauthenticatedContext().firestore()
    await assertSucceeds(getDoc(doc(anon, 'estimates', 'pending1')))
    await assertFails(getDoc(doc(anon, 'estimatePrivate', 'pending1')))
    await assertSucceeds(updateDoc(doc(anon, 'estimates', 'pending1'), {
      status: 'approved', signedAtMs: Date.now(),
      customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date().toISOString() },
    }))
    await assertSucceeds(getDoc(doc(env.authenticatedContext(ALICE).firestore(), 'estimatePrivate', 'pending1')))
  })

  it('an estimate saved raw again later (an old open app tab) is cleaned on the next run, keeping its new total', async () => {
    // (Each write also carries the update time it read, so a save landing
    // between the read and the write makes that one write fail instead of
    // overwriting it; the emulator offers no hook to stage that race here.)
    run('--write')
    await seed('estimates/pending1', quickQuote({ total: 999 }))
    const out = run('--write')
    expect(out).toContain('To clean: 1')
    expect((await byId('estimates')).get('pending1')!.total).toBe(999)
  })
})
