// Firestore rules for setaside_waitlist, run against the emulator:
//   npm run test:rules   (Node-only, so it lives outside src/ and the app tsconfig)
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, getDocs, collection, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore'

let env: RulesTestEnvironment

const idFor = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

function signup(email = 'Pat@Example.com', extra: Record<string, unknown> = {}) {
  return {
    email,
    emailLower: email.trim().toLowerCase(),
    trade: 'Carpenter',
    source: 'safe-to-spend-calculator',
    filingStatus: 'single',
    state: 'nc',
    annualNetBucket: '25-50k',
    createdAt: serverTimestamp(),
    ...extra,
  }
}

const anon = () => env.unauthenticatedContext().firestore()

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-setaside',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  })
})
beforeEach(async () => { await env.clearFirestore() })
afterAll(async () => { await env.cleanup() })

describe('setaside_waitlist rules', () => {
  it('allows a valid signup', async () => {
    await assertSucceeds(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')), signup()))
  })

  it('allows the optional fields', async () => {
    await assertSucceeds(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')),
      signup('Pat@Example.com', { firstName: 'Pat', utm_source: 'fb', utm_medium: 'social', utm_campaign: 'launch' })))
  })

  it('rejects extra fields', async () => {
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')),
      signup('Pat@Example.com', { annualNet: 48250 })))
  })

  it('rejects a bad email', async () => {
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('not-an-email')), signup('not-an-email')))
  })

  it('rejects an email of 254+ characters', async () => {
    const long = `${'a'.repeat(250)}@x.co`
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor(long)), signup(long)))
  })

  it('rejects a doc id that is not the email hash', async () => {
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('someone@else.com')), signup()))
  })

  it('rejects a client-chosen createdAt', async () => {
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')),
      signup('Pat@Example.com', { createdAt: Timestamp.fromMillis(Date.now()) })))
  })

  it('rejects an unknown trade or source', async () => {
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')), signup('Pat@Example.com', { trade: 'Spammer' })))
    await assertFails(setDoc(doc(anon(), 'setaside_waitlist', idFor('Pat@Example.com')), signup('Pat@Example.com', { source: 'elsewhere' })))
  })

  describe('existing signup', () => {
    const id = idFor('Pat@Example.com')
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async ctx => {
        await setDoc(doc(ctx.firestore(), 'setaside_waitlist', id), { ...signup(), createdAt: Timestamp.now() })
      })
    })

    it('denies a duplicate signup (update)', async () => {
      await assertFails(setDoc(doc(anon(), 'setaside_waitlist', id), signup()))
    })
    it('denies reads, signed in or not', async () => {
      await assertFails(getDoc(doc(anon(), 'setaside_waitlist', id)))
      await assertFails(getDocs(collection(anon(), 'setaside_waitlist')))
      await assertFails(getDoc(doc(env.authenticatedContext('user_1').firestore(), 'setaside_waitlist', id)))
    })
    it('denies update', async () => {
      await assertFails(updateDoc(doc(anon(), 'setaside_waitlist', id), { trade: 'Roofer' }))
    })
    it('denies delete', async () => {
      await assertFails(deleteDoc(doc(anon(), 'setaside_waitlist', id)))
      await assertFails(deleteDoc(doc(env.authenticatedContext('user_1').firestore(), 'setaside_waitlist', id)))
    })
  })
})
