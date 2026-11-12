// Firestore + Storage rules for the contractor app itself (customers, estimates,
// change orders, invoices, projects, profiles, photos). Run against the emulator:
//   npm run test:rules
//
// The point of these is tenant isolation and the public share pages: a customer
// with a link can open and answer ONE document, and nobody can browse anyone
// else's data.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch,
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
    projectId: 'demo-buildpro-app',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  })
})
beforeEach(async () => { await env.clearFirestore(); await env.clearStorage() })
afterAll(async () => { await env.cleanup() })

describe('nobody can browse another contractor\'s data', () => {
  const shared = ['estimates', 'changeOrders', 'invoices', 'thankYouPackages']
  // Contractor-private: no access of any kind for anyone but the owner.
  const privateOnly = ['customers', 'customerPhotos', 'projects', 'projectPhotos', 'calendarEvents']

  beforeEach(async () => {
    for (const c of shared) await seed(`${c}/a1`, { createdBy: ALICE, customerName: 'Pat Doe', status: 'pending' })
    for (const c of privateOnly) await seed(`${c}/a1`, { createdBy: ALICE, customerId: 'a1', customerName: 'Pat Doe', notes: 'gate code 4411', status: 'lead' })
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

  for (const c of privateOnly) {
    it(`${c}: private — no one but the owner can open, list, change or delete`, async () => {
      for (const who of [anon(), as(BOB)]) {
        await assertFails(getDoc(doc(who, c, 'a1')))
        await assertFails(getDocs(collection(who, c)))
        await assertFails(getDocs(query(collection(who, c), where('createdBy', '==', ALICE))))
        await assertFails(getDocs(query(collection(who, c), where('customerId', '==', 'a1'))))
        await assertFails(updateDoc(doc(who, c, 'a1'), { customerName: 'Hacked' }))
        await assertFails(deleteDoc(doc(who, c, 'a1')))
      }
      await assertFails(addDoc(collection(as(BOB), c), { createdBy: ALICE, customerName: 'x' }))
      await assertSucceeds(getDoc(doc(as(ALICE), c, 'a1')))
      await assertSucceeds(getDocs(query(collection(as(ALICE), c), where('createdBy', '==', ALICE))))
      await assertSucceeds(updateDoc(doc(as(ALICE), c, 'a1'), { customerName: 'Pat D.' }))
    })
  }

  it('a contractor\'s profile and billing state are readable only by them', async () => {
    await assertFails(getDoc(doc(anon(), 'users', ALICE)))
    await assertFails(getDoc(doc(as(BOB), 'users', ALICE)))
    await assertSucceeds(getDoc(doc(as(ALICE), 'users', ALICE)))
    await assertFails(getDocs(collection(anon(), 'users')))
    await assertFails(getDocs(collection(as(BOB), 'users')))
    await assertFails(getDocs(collection(as(ALICE), 'users')))
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

describe('a signed estimate is never edited; changes become a revision', () => {
  const signedAt = Date.now()
  beforeEach(async () => {
    await seed('estimates/e1', estimate({ status: 'approved', customerResponse: response('approved'), signedAtMs: signedAt }))
  })
  const mine = (id = 'e1') => doc(as(ALICE), 'estimates', id)

  it('the contractor cannot change what the customer signed', async () => {
    await assertFails(updateDoc(mine(), { total: 9999 }))
    await assertFails(updateDoc(mine(), { customerName: 'Someone Else' }))
    await assertFails(updateDoc(mine(), { depositAmount: 0 }))
    await assertFails(updateDoc(mine(), { aiQuote: { final_customer_quote: 1 } }))
    await assertFails(updateDoc(mine(), { signedAtMs: 1 }))
    await assertFails(updateDoc(mine(), { customerResponse: response('approved', { signedName: 'Forged' }) }))
  })
  it('the contractor cannot un-sign it by resetting it to pending', async () => {
    await assertFails(updateDoc(mine(), { status: 'pending', total: 3900 }))
  })
  it('bookkeeping links can still be set on a signed estimate', async () => {
    await assertSucceeds(updateDoc(mine(), { projectId: 'est_e1', projectAutoCreated: true }))
    await assertSucceeds(updateDoc(mine(), { depositInvoiceCreated: true }))
    await assertSucceeds(updateDoc(mine(), { supersededBy: 'e2' }))
    await assertFails(updateDoc(mine(), { supersededBy: 42 }))
    await assertFails(updateDoc(doc(as(BOB), 'estimates', 'e1'), { supersededBy: 'e2' }))
  })
  it('a revision is saved as a new estimate in one write, and the customer signs it', async () => {
    const db = as(ALICE)
    const batch = writeBatch(db)
    batch.set(doc(db, 'estimates', 'e2'), estimate({ total: 4600, revision: 2, previousVersionId: 'e1', originalEstimateId: 'e1', projectId: 'est_e1' }))
    batch.update(doc(db, 'estimates', 'e1'), { supersededBy: 'e2' })
    await assertSucceeds(batch.commit())
    await assertSucceeds(updateDoc(doc(anon(), 'estimates', 'e2'), { status: 'approved', customerResponse: response('approved'), signedAtMs: Date.now() }))
    // The original stays exactly as signed, and cannot be answered again.
    await assertFails(updateDoc(doc(anon(), 'estimates', 'e1'), { status: 'declined', customerResponse: response('declined') }))
    let e1: Record<string, unknown> | undefined
    await env.withSecurityRulesDisabled(async ctx => { e1 = (await getDoc(doc(ctx.firestore(), 'estimates/e1'))).data() })
    expect(e1).toMatchObject({ total: 4200, status: 'approved', signedAtMs: signedAt, supersededBy: 'e2' })
  })
  it('only the customer can sign: the contractor cannot approve or create a signed estimate', async () => {
    await seed('estimates/p1', estimate())
    await assertFails(updateDoc(mine('p1'), { status: 'approved' }))
    await assertFails(updateDoc(mine('p1'), { signedAtMs: Date.now() }))
    await assertFails(setDoc(mine('n1'), estimate({ status: 'approved' })))
    await assertFails(setDoc(mine('n2'), estimate({ customerResponse: response('approved') })))
    await assertFails(setDoc(mine('n3'), estimate({ signedAtMs: Date.now() })))
    await assertSucceeds(setDoc(mine('n4'), estimate()))
  })
  it('an unsigned (declined) estimate can still be adjusted and re-sent in place', async () => {
    await seed('estimates/d1', estimate({ status: 'declined', customerResponse: response('declined') }))
    await assertSucceeds(updateDoc(mine('d1'), { status: 'pending', customerResponse: deleteField(), total: 3900 }))
  })
})

describe('a signed change order is never edited', () => {
  it('the contractor can edit an unsigned one but not a signed one, and cannot sign it themselves', async () => {
    await seed('changeOrders/open', { createdBy: ALICE, status: 'pending', delta: 350, newTotal: 4550 })
    await seed('changeOrders/signed', { createdBy: ALICE, status: 'approved', delta: 350, newTotal: 4550, customerResponse: response('approved'), signedAtMs: Date.now() })
    const co = (id: string) => doc(as(ALICE), 'changeOrders', id)
    await assertSucceeds(updateDoc(co('open'), { delta: 400, newTotal: 4600 }))
    await assertFails(updateDoc(co('open'), { status: 'approved' }))
    await assertFails(updateDoc(co('signed'), { delta: 1, newTotal: 4201 }))
    await assertFails(updateDoc(co('signed'), { status: 'pending', customerResponse: deleteField() }))
    await assertFails(setDoc(co('n1'), { createdBy: ALICE, status: 'approved', delta: 1, newTotal: 1 }))
    await assertSucceeds(setDoc(co('n2'), { createdBy: ALICE, status: 'pending', delta: 1, newTotal: 1 }))
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

describe('the public business card (publicProfiles)', () => {
  const card = (extra: Record<string, unknown> = {}) => ({
    businessName: 'Alice Builds', businessPhone: '555-0100', businessEmail: 'a@example.com',
    licenseNumber: 'NC-1', logoUrl: '', cardPaymentsEnabled: false, updatedAt: '2026-11-11T00:00:00.000Z', ...extra,
  })
  beforeEach(async () => {
    await seed('users/' + ALICE, { businessName: 'Alice Builds', tier: 'pro', stripeCustomerId: 'cus_x' })
    await seed('users/' + BOB, { businessName: 'Bob Co', connectPayoutsEnabled: true })
  })

  it('the contractor publishes their own card; anyone can open it; nobody can list', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'publicProfiles', ALICE), card()))
    await assertSucceeds(getDoc(doc(anon(), 'publicProfiles', ALICE)))
    await assertFails(getDocs(collection(anon(), 'publicProfiles')))
    await assertFails(getDocs(collection(as(ALICE), 'publicProfiles')))
  })
  it('nobody can publish or change someone else\'s card', async () => {
    await assertFails(setDoc(doc(as(BOB), 'publicProfiles', ALICE), card()))
    await assertFails(setDoc(doc(anon(), 'publicProfiles', ALICE), card()))
    await seed('publicProfiles/' + ALICE, card())
    await assertFails(updateDoc(doc(as(BOB), 'publicProfiles', ALICE), { businessName: 'Bob was here' }))
    await assertFails(deleteDoc(doc(as(BOB), 'publicProfiles', ALICE)))
  })
  it('billing fields cannot ride along on the card', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'publicProfiles', ALICE), card({ tier: 'pro' })))
    await assertFails(setDoc(doc(as(ALICE), 'publicProfiles', ALICE), card({ stripeCustomerId: 'cus_x' })))
  })
  it('"takes cards" must match what the server recorded', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'publicProfiles', ALICE), card({ cardPaymentsEnabled: true })))
    await assertSucceeds(setDoc(doc(as(BOB), 'publicProfiles', BOB), card({ cardPaymentsEnabled: true })))
    await assertFails(setDoc(doc(as(BOB), 'publicProfiles', BOB), card({ cardPaymentsEnabled: false })))
  })
})

describe('the published photo log (photoLogs)', () => {
  const log = (uid: string, extra: Record<string, unknown> = {}) => ({
    createdBy: uid, customerName: 'Pat Doe', address: '1 Elm St',
    photos: [{ id: 'p1', photoUrl: 'https://example.com/p1.jpg', caption: 'demo day', createdAt: '2026-11-01T00:00:00.000Z' }],
    updatedAt: '2026-11-11T00:00:00.000Z', ...extra,
  })
  beforeEach(async () => {
    await seed('customers/c1', { createdBy: ALICE, name: 'Pat Doe', phone: '555-0199', notes: 'gate code 4411' })
  })

  it('the owner publishes it and the customer opens it signed-out by its link', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'photoLogs', 'c1'), log(ALICE)))
    await assertSucceeds(getDoc(doc(anon(), 'photoLogs', 'c1')))
    await assertSucceeds(setDoc(doc(as(ALICE), 'photoLogs', 'c1'), log(ALICE, { photos: [] })))
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'photoLogs', 'c1')))
  })
  it('logs cannot be listed or searched by anyone', async () => {
    await seed('photoLogs/c1', log(ALICE))
    await assertFails(getDocs(collection(anon(), 'photoLogs')))
    await assertFails(getDocs(query(collection(as(BOB), 'photoLogs'), where('createdBy', '==', ALICE))))
    await assertFails(getDocs(query(collection(as(ALICE), 'photoLogs'), where('createdBy', '==', ALICE))))
  })
  it('another contractor cannot publish a log for a customer that is not theirs', async () => {
    await assertFails(setDoc(doc(as(BOB), 'photoLogs', 'c1'), log(BOB)))
    await assertFails(setDoc(doc(as(BOB), 'photoLogs', 'c1'), log(ALICE)))
    await assertFails(setDoc(doc(as(BOB), 'photoLogs', 'no-such-customer'), log(BOB)))
    await seed('photoLogs/c1', log(ALICE))
    await assertFails(updateDoc(doc(as(BOB), 'photoLogs', 'c1'), { customerName: 'Hacked' }))
    await assertFails(deleteDoc(doc(as(BOB), 'photoLogs', 'c1')))
    await assertFails(deleteDoc(doc(anon(), 'photoLogs', 'c1')))
  })
  it('private customer fields cannot be published into the log', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'photoLogs', 'c1'), log(ALICE, { notes: 'gate code 4411' })))
    await assertFails(setDoc(doc(as(ALICE), 'photoLogs', 'c1'), log(ALICE, { phone: '555-0199' })))
  })
})

describe('account deletion requests', () => {
  const req = (extra: Record<string, unknown> = {}) => ({ status: 'requested', requestedAt: '2026-11-11T00:00:00.000Z', ...extra })
  it('a contractor can make, see and cancel their own request', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE), req({ note: 'closing the business' })))
    await assertSucceeds(getDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE)))
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE)))
  })
  it('nobody can file, read or cancel a request for someone else', async () => {
    await assertFails(setDoc(doc(as(BOB), 'accountDeletionRequests', ALICE), req()))
    await assertFails(setDoc(doc(anon(), 'accountDeletionRequests', ALICE), req()))
    await seed('accountDeletionRequests/' + ALICE, req())
    await assertFails(getDoc(doc(as(BOB), 'accountDeletionRequests', ALICE)))
    await assertFails(getDoc(doc(anon(), 'accountDeletionRequests', ALICE)))
    await assertFails(deleteDoc(doc(as(BOB), 'accountDeletionRequests', ALICE)))
    await assertFails(getDocs(collection(as(ALICE), 'accountDeletionRequests')))
  })
  it('a request cannot carry other fields or be edited afterwards', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE), req({ status: 'done' })))
    await assertFails(setDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE), req({ tier: 'pro' })))
    await seed('accountDeletionRequests/' + ALICE, req())
    await assertFails(updateDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE), { note: 'changed' }))
  })
})
