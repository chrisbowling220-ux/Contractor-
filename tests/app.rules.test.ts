// Firestore + Storage rules for the contractor app itself (customers, estimates,
// change orders, invoices, projects, profiles, photos). Run against the emulator:
//   npm run test:rules
//
// The point of these is tenant isolation and the public share pages: a customer
// with a link can open and answer ONE document, and nobody can browse anyone
// else's data.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where,
} from 'firebase/firestore'
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage'

let env: RulesTestEnvironment

const ALICE = 'user_alice'
const BOB = 'user_bob'
const anon = () => env.unauthenticatedContext().firestore()
const as = (uid: string) => env.authenticatedContext(uid).firestore()

// Seed documents with rules switched off, the way the Admin SDK would.
async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data) })
}

const estimate = (extra: Record<string, unknown> = {}) => ({
  createdBy: ALICE, customerName: 'Pat Doe', total: 4200, status: 'pending',
  depositRequested: true, depositAmount: 1000, createdAt: '2026-11-01T12:00:00.000Z', ...extra,
})
const response = (action: 'approved' | 'declined', extra: Record<string, unknown> = {}) => ({
  action, signedName: 'Pat Doe', respondedAt: new Date().toISOString(), ...extra,
})

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-setaside',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  })
})
beforeEach(async () => { await env.clearFirestore(); await env.clearStorage() })
afterAll(async () => { await env.cleanup() })

describe('nobody can browse another contractor\'s data', () => {
  const shared = ['customers', 'estimates', 'changeOrders', 'invoices', 'thankYouPackages']

  beforeEach(async () => {
    for (const c of shared) await seed(`${c}/a1`, { createdBy: ALICE, customerName: 'Pat Doe', status: 'pending' })
    await seed('projects/a1', { createdBy: ALICE, customerName: 'Pat Doe', status: 'lead' })
    await seed('users/' + ALICE, { businessName: 'Alice Builds', tier: 'free', aiQuotesUsed: 7 })
  })

  for (const c of shared) {
    it(`${c}: a signed-out visitor cannot list the collection`, async () => {
      await assertFails(getDocs(collection(anon(), c)))
      await assertFails(getDocs(query(collection(anon(), c), where('createdBy', '==', ALICE))))
    })
    it(`${c}: another contractor cannot list them`, async () => {
      await assertFails(getDocs(collection(as(BOB), c)))
      await assertFails(getDocs(query(collection(as(BOB), c), where('createdBy', '==', ALICE))))
    })
    it(`${c}: the owner can list their own`, async () => {
      await assertSucceeds(getDocs(query(collection(as(ALICE), c), where('createdBy', '==', ALICE))))
    })
    it(`${c}: a share link (one document by id) still opens signed-out`, async () => {
      await assertSucceeds(getDoc(doc(anon(), c, 'a1')))
    })
    it(`${c}: another contractor cannot edit or delete it`, async () => {
      await assertFails(updateDoc(doc(as(BOB), c, 'a1'), { customerName: 'Hacked' }))
      await assertFails(deleteDoc(doc(as(BOB), c, 'a1')))
    })
    it(`${c}: cannot create a document owned by someone else`, async () => {
      await assertFails(addDoc(collection(as(BOB), c), { createdBy: ALICE, customerName: 'x' }))
      await assertSucceeds(addDoc(collection(as(BOB), c), { createdBy: BOB, customerName: 'x' }))
    })
  }

  it('projects are private: no public read at all', async () => {
    await assertFails(getDoc(doc(anon(), 'projects', 'a1')))
    await assertFails(getDoc(doc(as(BOB), 'projects', 'a1')))
    await assertSucceeds(getDoc(doc(as(ALICE), 'projects', 'a1')))
  })

  it('profiles open one at a time but cannot be listed', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'users', ALICE)))
    await assertFails(getDocs(collection(anon(), 'users')))
    await assertFails(getDocs(collection(as(BOB), 'users')))
  })

  it('a contractor cannot grant themselves Pro or touch billing fields', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'users', ALICE), { tier: 'pro' }, { merge: true }))
    await assertFails(setDoc(doc(as(ALICE), 'users', ALICE), { aiQuotesUsed: 0 }, { merge: true }))
    await assertFails(setDoc(doc(as(ALICE), 'users', ALICE), { connectPayoutsEnabled: true }, { merge: true }))
    await assertSucceeds(setDoc(doc(as(ALICE), 'users', ALICE), { businessName: 'Alice Builds LLC' }, { merge: true }))
    await assertFails(setDoc(doc(as(BOB), 'users', ALICE), { businessName: 'Bob was here' }, { merge: true }))
  })
})

describe('customer sign-off on an estimate', () => {
  beforeEach(async () => { await seed('estimates/e1', estimate()) })
  const e1 = () => doc(anon(), 'estimates', 'e1')

  it('approves a pending estimate', async () => {
    await assertSucceeds(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
  })
  it('declines a pending estimate with a reason', async () => {
    await assertSucceeds(updateDoc(e1(), { status: 'declined', customerResponse: response('declined', { reason: 'Too high' }) }))
  })
  it('cannot change the price or deposit while signing', async () => {
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now(), total: 1 }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now(), depositAmount: 0 }))
    await assertFails(updateDoc(e1(), { total: 1 }))
  })
  it('cannot answer twice: an approved estimate stays approved', async () => {
    await seed('estimates/e1', estimate({ status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
    await assertFails(updateDoc(e1(), { status: 'declined', customerResponse: response('declined') }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved', { signedName: 'Someone Else' }), signedAtMs: Date.now() }))
  })
  it('cannot re-open a declined estimate', async () => {
    await seed('estimates/e1', estimate({ status: 'declined', customerResponse: response('declined') }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
  })
  it('the response has to match the status and carry a real name', async () => {
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('declined'), signedAtMs: Date.now() }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved', { signedName: '' }), signedAtMs: Date.now() }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved', { signedName: 'x'.repeat(500) }), signedAtMs: Date.now() }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved', { extra: 'field' }), signedAtMs: Date.now() }))
    await assertFails(updateDoc(e1(), { status: 'pending', customerResponse: response('approved') }))
  })
  it('cannot forge the retention clock', async () => {
    const tenYears = Date.now() + 10 * 365 * 86400000
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: tenYears }))
    await assertFails(updateDoc(e1(), { status: 'approved', customerResponse: response('approved') })) // approval must stamp it
    await assertFails(updateDoc(e1(), { status: 'declined', customerResponse: response('declined'), signedAtMs: tenYears }))
  })
  it('the start-date reply can be given once and must be well-formed', async () => {
    await assertFails(updateDoc(e1(), { startDateResponse: { action: 'whatever', respondedAt: 'x' } }))
    await assertSucceeds(updateDoc(e1(), { startDateResponse: { action: 'requested_change', requestedDate: '2026-12-01', respondedAt: new Date().toISOString() } }))
    await assertFails(updateDoc(e1(), { startDateResponse: { action: 'confirmed', respondedAt: new Date().toISOString() } }))
  })
  it('the owner can re-send (reset to pending) and the customer can answer again', async () => {
    await seed('estimates/e1', estimate({ status: 'declined', customerResponse: response('declined'), signedAtMs: 1 }))
    await assertSucceeds(updateDoc(doc(as(ALICE), 'estimates', 'e1'), { status: 'pending', total: 3900 }))
    await assertSucceeds(updateDoc(e1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
  })
  it('a signed estimate cannot be deleted inside the 2-year retention window', async () => {
    await seed('estimates/e1', estimate({ status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
    await assertFails(deleteDoc(doc(as(ALICE), 'estimates', 'e1')))
    await seed('estimates/old', estimate({ status: 'approved', signedAtMs: Date.now() - 3 * 365 * 86400000 }))
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'estimates', 'old')))
  })
})

describe('customer sign-off on a change order', () => {
  beforeEach(async () => { await seed('changeOrders/c1', { createdBy: ALICE, status: 'pending', delta: 350, newTotal: 4550 }) })
  const c1 = () => doc(anon(), 'changeOrders', 'c1')

  it('approves once, then is locked to the customer', async () => {
    await assertSucceeds(updateDoc(c1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
    await assertFails(updateDoc(c1(), { status: 'declined', customerResponse: response('declined') }))
  })
  it('cannot change the amount', async () => {
    await assertFails(updateDoc(c1(), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now(), delta: -5000 }))
  })
})

describe('invoices on the public pay page', () => {
  beforeEach(async () => {
    await seed('invoices/i1', { createdBy: ALICE, status: 'sent', subtotal: 4200, amountPaid: 1000, amountDue: 3200 })
  })
  const i1 = () => doc(anon(), 'invoices', 'i1')

  it('the customer can say they will pay in person', async () => {
    await assertSucceeds(updateDoc(i1(), { customerCashChoice: true, customerCashAt: new Date().toISOString() }))
  })
  it('the customer cannot mark it paid, change what is owed, or record a payment', async () => {
    await assertFails(updateDoc(i1(), { status: 'paid' }))
    await assertFails(updateDoc(i1(), { amountDue: 0 }))
    await assertFails(updateDoc(i1(), { amountPaid: 4200 }))
    await assertFails(updateDoc(i1(), { payments: [{ amount: 3200, method: 'cash' }] }))
    await assertFails(updateDoc(i1(), { customerCashChoice: true, customerCashAt: 'x', amountDue: 1 }))
  })
  it('a paid invoice is closed to the public', async () => {
    await seed('invoices/i1', { createdBy: ALICE, status: 'paid', subtotal: 4200, amountDue: 0, paidAtMs: Date.now() })
    await assertFails(updateDoc(i1(), { customerCashChoice: true, customerCashAt: new Date().toISOString() }))
  })
  it('the owner can record a payment', async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), 'invoices', 'i1'), {
      payments: [{ id: 'p1', amount: 500, method: 'check', date: '2026-11-10', recordedAt: new Date().toISOString() }],
      amountPaid: 1500, amountDue: 2700,
    }))
  })
  it('a paid invoice cannot be deleted inside the 2-year retention window', async () => {
    await seed('invoices/i1', { createdBy: ALICE, status: 'paid', paidAtMs: Date.now() })
    await assertFails(deleteDoc(doc(as(ALICE), 'invoices', 'i1')))
  })
})

describe('photo and logo storage', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
  const store = (uid?: string) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage()

  it('a contractor can upload, read and delete their own photos', async () => {
    const r = ref(store(ALICE), `projectPhotos/${ALICE}/p1/a.jpg`)
    await assertSucceeds(uploadBytes(r, jpeg, { contentType: 'image/jpeg' }))
    await assertSucceeds(getBytes(r))
    await assertSucceeds(deleteObject(r))
  })
  it('nobody else can read or write them', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await uploadBytes(ref(ctx.storage(), `projectPhotos/${ALICE}/p1/a.jpg`), jpeg, { contentType: 'image/jpeg' })
    })
    await assertFails(getBytes(ref(store(BOB), `projectPhotos/${ALICE}/p1/a.jpg`)))
    await assertFails(getBytes(ref(store(), `projectPhotos/${ALICE}/p1/a.jpg`)))
    await assertFails(uploadBytes(ref(store(BOB), `projectPhotos/${ALICE}/p1/b.jpg`), jpeg, { contentType: 'image/jpeg' }))
    await assertFails(deleteObject(ref(store(BOB), `projectPhotos/${ALICE}/p1/a.jpg`)))
  })
  it('only images are accepted', async () => {
    await assertFails(uploadBytes(ref(store(ALICE), `customerPhotos/${ALICE}/c1/x.html`), jpeg, { contentType: 'text/html' }))
    await assertFails(uploadBytes(ref(store(ALICE), `userLogos/${ALICE}/x.exe`), jpeg, { contentType: 'application/octet-stream' }))
    await assertSucceeds(uploadBytes(ref(store(ALICE), `userLogos/${ALICE}/logo.png`), jpeg, { contentType: 'image/png' }))
  })
  it('paths outside the three photo folders are closed', async () => {
    await assertFails(uploadBytes(ref(store(ALICE), `elsewhere/${ALICE}/a.jpg`), jpeg, { contentType: 'image/jpeg' }))
  })
})
