// firestore.transition.rules is deployed together with the new app version and
// replaced by firestore.rules once contractors have opened the new app. It
// must (a) keep share links sent earlier working, (b) allow everything the new
// app writes, and (c) differ from the final rules in exactly three reads.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore'

let env: RulesTestEnvironment
const ALICE = 'user_alice'
const BOB = 'user_bob'
const anon = () => env.unauthenticatedContext().firestore()
const as = (uid: string) => env.authenticatedContext(uid).firestore()
async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data) })
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-buildpro-transition',
    firestore: { rules: readFileSync('firestore.transition.rules', 'utf8') },
  })
})
beforeEach(async () => {
  await env.clearFirestore()
  await seed('users/' + ALICE, { businessName: 'Alice Builds' })
  await seed('customers/c1', { createdBy: ALICE, name: 'Pat Doe' })
  await seed('customerPhotos/ph1', { createdBy: ALICE, customerId: 'c1', photoUrl: 'u' })
})
afterAll(async () => { await env.cleanup() })

describe('transition rules', () => {
  it('differ from the final rules only on lines marked TRANSITION', () => {
    const strip = (s: string) => s.split('\n').map(l => l.trimEnd())
    const final = new Set(strip(readFileSync('firestore.rules', 'utf8')))
    const extra = strip(readFileSync('firestore.transition.rules', 'utf8'))
      .filter(l => !final.has(l) && !l.trim().startsWith('//') && l.trim() !== '')
    // (The customers list rule that `allow read` is split into already exists
    // verbatim elsewhere in the final rules.)
    expect(extra).toHaveLength(3)
    expect(extra.every(l => l.includes('TRANSITION'))).toBe(true)
  })

  it('share links sent before the new app keep working', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'users', ALICE)))
    await assertSucceeds(getDoc(doc(anon(), 'customers', 'c1')))
    await assertSucceeds(getDocs(query(collection(anon(), 'customerPhotos'), where('customerId', '==', 'c1'))))
  })

  it('still closes what the urgent rules closed', async () => {
    await assertFails(getDocs(collection(anon(), 'users')))
    await assertFails(getDocs(collection(anon(), 'customers')))
    await assertFails(getDocs(query(collection(as(BOB), 'customers'), where('createdBy', '==', ALICE))))
    await assertFails(getDocs(collection(anon(), 'estimates')))
    await assertFails(getDocs(collection(anon(), 'invoices')))
  })

  it('allows what the new app writes', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'publicProfiles', ALICE), {
      businessName: 'Alice Builds', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '',
      cardPaymentsEnabled: false, updatedAt: '2026-11-11T00:00:00.000Z',
    }))
    await assertSucceeds(setDoc(doc(as(ALICE), 'photoLogs', 'c1'), {
      createdBy: ALICE, customerName: 'Pat Doe', address: '', photos: [], updatedAt: '2026-11-11T00:00:00.000Z',
    }))
    await assertFails(setDoc(doc(as(BOB), 'photoLogs', 'c1'), {
      createdBy: BOB, customerName: 'x', address: '', photos: [], updatedAt: 'x',
    }))
    await assertSucceeds(setDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE), { status: 'requested', requestedAt: '2026-11-11T00:00:00.000Z' }))
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'accountDeletionRequests', ALICE)))
  })
})
