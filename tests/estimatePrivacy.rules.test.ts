// An estimate is opened by its link without signing in, and the database hands
// over the whole document. These check that the private side of an estimate
// (notes, markup, a Quick Quote's spoken walkthrough) cannot be stored on it,
// lives in estimatePrivate where only the contractor can read it, and that
// estimates saved before this change (still carrying those fields) keep
// working: customers can sign them, and contractors can still link them up.
//
// Runs against BOTH the final and the transition rules: the release deploys
// the transition rules first, and the protection must be there from the start.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { customerSafeEstimate, splitEstimateForSharing } from '../src/lib/estimatePrivacy'

const ALICE = 'user_alice'
const BOB = 'user_bob'

const rawQuote = (extra: Record<string, unknown> = {}) => ({
  customer_summary: 'Replace the back deck boards',
  work_scope: 'Remove and replace 240 sq ft of decking',
  material_list: [
    { name: '5/4x6 PT board', base_quantity: 40, waste_percent: 10, quantity_with_waste: 44, quantity_math: '', unit: 'each', unit_price: 10, line_total: 440 },
  ],
  labor: { estimated_hours: 10, breakdown: 'tear-out and install', hourly_rate: 60, labor_total: 600 },
  price_breakdown: { labor_subtotal: 600, materials_subtotal: 440, rentals_subtotal: 0, raw_cost: 1040 },
  profit_markup: { markup_percent: 25, markup_dollars: 260, rationale: 'Older customer, low price sensitivity' },
  final_customer_quote: 1300,
  contractor_notes: 'Joists look soft near the door, verify before sending. Customer haggles.',
  ...extra,
})

const quickQuote = (extra: Record<string, unknown> = {}) => ({
  createdBy: ALICE, customerName: 'Pat Doe', jobTypeId: 'quick-quote', jobTypeName: 'Quick Quote',
  description: 'ok so this is the Doe place, she wants it cheap, I would charge more',
  laborTotal: 600, materialsTotal: 440, rentalsTotal: 0, total: 1300,
  aiQuote: rawQuote(), status: 'pending', createdAt: '2026-11-01T12:00:00.000Z',
  ...extra,
})

for (const rulesFile of ['firestore.rules', 'firestore.transition.rules']) {
  describe(`estimate privacy (${rulesFile})`, () => {
    let env: RulesTestEnvironment
    const anon = () => env.unauthenticatedContext().firestore()
    const as = (uid: string) => env.authenticatedContext(uid).firestore()
    const seed = async (path: string, data: Record<string, unknown>) => {
      await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data) })
    }

    beforeAll(async () => {
      env = await initializeTestEnvironment({
        projectId: `demo-estimate-privacy-${rulesFile.includes('transition') ? 't' : 'f'}`,
        firestore: { rules: readFileSync(rulesFile, 'utf8') },
      })
    })
    beforeEach(async () => { await env.clearFirestore() })
    afterAll(async () => { await env.cleanup() })

    it('a new estimate carrying notes, markup or a walkthrough is refused', async () => {
      const db = as(ALICE)
      await assertFails(setDoc(doc(db, 'estimates', 'n1'), quickQuote()))
      await assertFails(setDoc(doc(db, 'estimates', 'n2'), quickQuote({ description: '', aiQuote: rawQuote({ profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' } }) })))
      await assertFails(setDoc(doc(db, 'estimates', 'n3'), quickQuote({ description: '', aiQuote: rawQuote({ contractor_notes: '' }) })))
      await assertFails(setDoc(doc(db, 'estimates', 'n4'), quickQuote({ description: '', aiQuote: rawQuote({ contractor_notes: '', profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: 'why' } }) })))
      // Walkthrough left on an otherwise clean Quick Quote.
      const { safe } = customerSafeEstimate(quickQuote())
      await assertFails(setDoc(doc(db, 'estimates', 'n5'), { ...safe, description: 'spoken notes' }))
    })

    it('the app\'s own save (customer view + private record, one write) is accepted', async () => {
      const db = as(ALICE)
      const { safe, privateFields } = customerSafeEstimate(quickQuote())
      const batch = writeBatch(db)
      batch.set(doc(db, 'estimates', 'e1'), safe)
      batch.set(doc(db, 'estimatePrivate', 'e1'), { createdBy: ALICE, ...privateFields, updatedAt: new Date().toISOString() })
      await assertSucceeds(batch.commit())

      // What a customer's link can read: same total, nothing private.
      const shared = (await getDoc(doc(anon(), 'estimates', 'e1'))).data() as Record<string, unknown>
      const json = JSON.stringify(shared)
      expect(shared.total).toBe(1300)
      expect(json).not.toContain('Joists look soft')
      expect(json).not.toContain('haggles')
      expect(json).not.toContain('low price sensitivity')
      expect(json).not.toContain('charge more')
      expect((shared.aiQuote as { profit_markup: unknown }).profit_markup).toEqual({ markup_percent: 0, markup_dollars: 0, rationale: '' })
      // The cost-price subtotal is gone too (it gave the markup away by subtraction).
      expect(shared.materialsTotal).toBe(700)
    })

    it('a hand-built estimate keeps its customer-facing description', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), 'estimates', 'm1'), {
        createdBy: ALICE, customerName: 'Pat Doe', jobTypeId: 'manual', jobTypeName: 'Deck',
        description: 'Replace deck boards', total: 900, status: 'pending', createdAt: '2026-11-01T12:00:00.000Z',
      }))
    })

    it('the private record: only its contractor can read, write or delete it; nobody can list it', async () => {
      await seed('estimates/e1', { ...customerSafeEstimate(quickQuote()).safe })
      await seed('estimatePrivate/e1', { createdBy: ALICE, contractorNotes: 'Joists look soft', narration: 'walkthrough' })
      await assertFails(getDoc(doc(anon(), 'estimatePrivate', 'e1')))
      await assertFails(getDoc(doc(as(BOB), 'estimatePrivate', 'e1')))
      await assertFails(getDocs(collection(anon(), 'estimatePrivate')))
      await assertFails(getDocs(query(collection(as(BOB), 'estimatePrivate'), where('createdBy', '==', ALICE))))
      await assertFails(updateDoc(doc(as(BOB), 'estimatePrivate', 'e1'), { contractorNotes: 'x' }))
      await assertFails(deleteDoc(doc(as(BOB), 'estimatePrivate', 'e1')))
      await assertSucceeds(getDoc(doc(as(ALICE), 'estimatePrivate', 'e1')))
      await assertSucceeds(getDocs(query(collection(as(ALICE), 'estimatePrivate'), where('createdBy', '==', ALICE))))
      await assertSucceeds(updateDoc(doc(as(ALICE), 'estimatePrivate', 'e1'), { contractorNotes: 'Sistered two joists' }))
      await assertFails(updateDoc(doc(as(ALICE), 'estimatePrivate', 'e1'), { createdBy: BOB }))
      await assertFails(updateDoc(doc(as(ALICE), 'estimatePrivate', 'e1'), { total: 1 }))
      await assertSucceeds(deleteDoc(doc(as(ALICE), 'estimatePrivate', 'e1')))
    })

    it('nobody can create a private record for an estimate that is not theirs', async () => {
      await seed('estimates/e1', { ...customerSafeEstimate(quickQuote()).safe })
      await assertFails(setDoc(doc(as(BOB), 'estimatePrivate', 'e1'), { createdBy: BOB, contractorNotes: 'x' }))
      await assertFails(setDoc(doc(as(BOB), 'estimatePrivate', 'e1'), { createdBy: ALICE, contractorNotes: 'x' }))
      await assertFails(setDoc(doc(as(ALICE), 'estimatePrivate', 'nope'), { createdBy: ALICE, contractorNotes: 'x' }))
      await assertSucceeds(setDoc(doc(as(ALICE), 'estimatePrivate', 'e1'), { createdBy: ALICE, contractorNotes: 'x' }))
    })

    describe('estimates saved before this change', () => {
      beforeEach(async () => { await seed('estimates/old', quickQuote()) })

      it('the customer can still open and sign one', async () => {
        await assertSucceeds(getDoc(doc(anon(), 'estimates', 'old')))
        await assertSucceeds(updateDoc(doc(anon(), 'estimates', 'old'), {
          status: 'approved', signedAtMs: Date.now(),
          customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date().toISOString() },
        }))
      })

      it('the contractor can still link it, attach a proposal and answer for the start date', async () => {
        await assertSucceeds(updateDoc(doc(as(ALICE), 'estimates', 'old'), { projectId: 'p1', projectAutoCreated: true }))
        await assertSucceeds(updateDoc(doc(as(ALICE), 'estimates', 'old'), { proposal: { greeting: 'Hi' }, proposalEdited: false }))
      })

      it('saving its quote again must save it customer-safe (the editor moves the rest out)', async () => {
        const db = as(ALICE)
        await assertFails(updateDoc(doc(db, 'estimates', 'old'), { aiQuote: rawQuote({ final_customer_quote: 1400 }) }))
        const seeded = quickQuote()
        const split = splitEstimateForSharing(seeded)
        const batch = writeBatch(db)
        batch.update(doc(db, 'estimates', 'old'), split.publicPatch)
        batch.set(doc(db, 'estimatePrivate', 'old'), { createdBy: ALICE, ...split.privateFields }, { merge: true })
        await assertSucceeds(batch.commit())
      })

      it('a signed one still takes only bookkeeping links, and a revision of it is saved clean', async () => {
        await seed('estimates/signed', quickQuote({
          status: 'approved', signedAtMs: Date.now(),
          customerResponse: { action: 'approved', signedName: 'Pat Doe', respondedAt: new Date().toISOString() },
        }))
        const db = as(ALICE)
        // Cleaning a signed record is the migration's job (Admin), not the app's.
        await assertFails(updateDoc(doc(db, 'estimates', 'signed'), splitEstimateForSharing(quickQuote()).publicPatch))
        await assertSucceeds(updateDoc(doc(db, 'estimates', 'signed'), { supersededBy: 'rev2' }))
      })
    })
  })
}
