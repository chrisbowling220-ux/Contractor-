// Card payments and subscriptions, end to end on the server side: the Stripe
// webhook (with real signature checking), the deposit invoice a customer
// triggers by approving, and the card checkout.
import { stripeStub } from './mocks'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { all, clearDb, read, seed, serve, WEBHOOK_SECRET } from './harness'
import { stripeWebhook, createDepositInvoiceForApproval, createInvoiceCheckout } from '../src/index'

const OWNER = 'user_owner'
const signer = new Stripe('sk_test_not_a_real_key')

let hook: Awaited<ReturnType<typeof serve>>
let deposit: Awaited<ReturnType<typeof serve>>
let checkout: Awaited<ReturnType<typeof serve>>

beforeAll(async () => {
  hook = await serve(stripeWebhook)
  deposit = await serve(createDepositInvoiceForApproval)
  checkout = await serve(createInvoiceCheckout)
})
afterAll(async () => { await Promise.all([hook.close(), deposit.close(), checkout.close()]) })
beforeEach(async () => { await clearDb(); stripeStub.checkoutCalls.length = 0; stripeStub.checkoutError = null })

let eventSeq = 0
async function deliver(type: string, object: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${++eventSeq}`, object: 'event', type, data: { object } })
  const header = signer.webhooks.generateTestHeaderString({ payload, secret })
  return hook.post(payload, { 'stripe-signature': header })
}
const paidSession = (invoiceId: string, cents: number, id = 'cs_1') => ({
  id, object: 'checkout.session', mode: 'payment', payment_status: 'paid',
  amount_total: cents, payment_intent: 'pi_1', metadata: { invoiceId },
})
const invoice = (extra: Record<string, unknown> = {}) => ({
  createdBy: OWNER, projectId: 'p1', customerName: 'Pat Doe', invoiceNumber: 'INV-2026-0001',
  subtotal: 500, amountPaid: 0, amountDue: 500, status: 'sent', ...extra,
})

describe('Stripe webhook: who is allowed to call it', () => {
  it('rejects a call with no signature', async () => {
    const res = await hook.post({ type: 'checkout.session.completed' })
    expect(res.status).toBe(400)
  })
  it('rejects a forged event signed with the wrong secret, and changes nothing', async () => {
    await seed('invoices/i1', invoice())
    const res = await deliver('checkout.session.completed', paidSession('i1', 50000), 'whsec_someone_elses')
    expect(res.status).toBe(400)
    expect((await read('invoices/i1'))?.status).toBe('sent')
  })
})

describe('Stripe webhook: a customer pays an invoice by card', () => {
  it('a paid DEPOSIT is recorded but the job stays open and its notes are untouched', async () => {
    await seed('projects/p1', { createdBy: OWNER, status: 'in_progress', notes: 'Customer wants the oak trim.' })
    await seed('invoices/i1', invoice({ isDeposit: true }))
    const res = await deliver('checkout.session.completed', paidSession('i1', 50000))
    expect(res.status).toBe(200)

    const inv = await read('invoices/i1')
    expect(inv).toMatchObject({ status: 'paid', amountDue: 0, amountPaid: 500 })
    expect(typeof inv?.paidAtMs).toBe('number')
    expect(inv?.payments).toEqual([expect.objectContaining({ id: 'stripe_cs_1', amount: 500, method: 'card', source: 'stripe' })])
    expect(await read('projects/p1')).toMatchObject({ status: 'in_progress', notes: 'Customer wants the oak trim.' })
  })

  it('the FINAL invoice on a completed job closes it', async () => {
    await seed('projects/p1', { createdBy: OWNER, status: 'completed', notes: 'keep me' })
    await seed('invoices/i1', invoice())
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    expect(await read('projects/p1')).toMatchObject({ status: 'closed', notes: 'keep me' })
  })

  it('a final invoice paid while work is still under way does not close the job', async () => {
    await seed('projects/p1', { createdBy: OWNER, status: 'in_progress' })
    await seed('invoices/i1', invoice())
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    expect((await read('projects/p1'))?.status).toBe('in_progress')
  })

  it('counts earlier cash or check payments and adds the card on top', async () => {
    await seed('invoices/i1', invoice({
      subtotal: 1200, amountPaid: 500, amountDue: 700,
      payments: [{ id: 'm1', amount: 500, method: 'check', date: '2026-11-05', source: 'manual' }],
    }))
    await deliver('checkout.session.completed', paidSession('i1', 70000))
    const inv = await read('invoices/i1')
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 1200, amountDue: 0 })
    expect((inv?.payments as unknown[]).length).toBe(2)
  })

  it('Stripe delivering the same event twice does not count the money twice', async () => {
    await seed('invoices/i1', invoice())
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    const first = await read('invoices/i1')
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    const second = await read('invoices/i1')
    expect(second?.amountPaid).toBe(500)
    expect(second?.paidAt).toBe(first?.paidAt)
    expect((second?.payments as unknown[]).length).toBe(1)
  })

  it('a card payment smaller than the balance is recorded but the invoice is NOT marked paid', async () => {
    // The customer opened a $500 checkout; the contractor then raised the
    // invoice to $900 before the payment landed.
    await seed('projects/p1', { createdBy: OWNER, status: 'completed' })
    await seed('invoices/i1', invoice({ subtotal: 900, amountDue: 900 }))
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    const inv = await read('invoices/i1')
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 500, amountDue: 400 })
    expect(inv?.paidAtMs).toBeUndefined()
    expect((await read('projects/p1'))?.status).toBe('completed')

    // A repeat delivery of that same checkout changes nothing.
    await deliver('checkout.session.completed', paidSession('i1', 50000))
    expect(await read('invoices/i1')).toMatchObject({ amountPaid: 500, amountDue: 400 })

    // The customer pays the rest with a second checkout: now it is paid.
    await deliver('checkout.session.completed', paidSession('i1', 40000, 'cs_2'))
    expect(await read('invoices/i1')).toMatchObject({ status: 'paid', amountPaid: 900, amountDue: 0 })
    expect((await read('projects/p1'))?.status).toBe('closed')
  })

  it('an unpaid or unknown checkout changes nothing', async () => {
    await seed('invoices/i1', invoice())
    await deliver('checkout.session.completed', { ...paidSession('i1', 50000), payment_status: 'unpaid' })
    expect((await read('invoices/i1'))?.status).toBe('sent')
    const res = await deliver('checkout.session.completed', paidSession('no-such-invoice', 50000))
    expect(res.status).toBe(200)
    expect(await read('invoices/no-such-invoice')).toBeUndefined()
  })
})

describe('Stripe webhook: subscriptions and quote packs', () => {
  const sub = (status: string, extra: Record<string, unknown> = {}) => ({
    id: 'sub_1', object: 'subscription', status, metadata: { clerkUserId: OWNER },
    cancel_at_period_end: false, current_period_end: 1800000000, ...extra,
  })
  it('an active subscription grants Pro with its paid-through date', async () => {
    await seed(`users/${OWNER}`, { businessName: 'Owner Co', tier: 'free' })
    await deliver('customer.subscription.created', sub('active'))
    expect(await read(`users/${OWNER}`)).toMatchObject({
      tier: 'pro', subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: 1800000000000, businessName: 'Owner Co',
    })
  })
  it('a failed renewal or a cancelled subscription drops back to free', async () => {
    await seed(`users/${OWNER}`, { tier: 'pro' })
    await deliver('customer.subscription.updated', sub('past_due'))
    expect((await read(`users/${OWNER}`))?.tier).toBe('free')
    await deliver('customer.subscription.updated', sub('active'))
    expect((await read(`users/${OWNER}`))?.tier).toBe('pro')
    await deliver('customer.subscription.deleted', sub('canceled'))
    expect((await read(`users/${OWNER}`))?.tier).toBe('free')
  })
  it('a quote pack adds credits once, even if the event arrives twice', async () => {
    await seed(`users/${OWNER}`, { tier: 'free', paidQuoteCredits: 1 })
    const pack = { id: 'cs_pack', object: 'checkout.session', mode: 'payment', payment_status: 'paid', metadata: { clerkUserId: OWNER, quoteCredits: '5' } }
    await deliver('checkout.session.completed', pack)
    await deliver('checkout.session.completed', pack)
    expect((await read(`users/${OWNER}`))?.paidQuoteCredits).toBe(6)
  })
  it('payout status follows the contractor\'s own connected account only', async () => {
    await seed(`users/${OWNER}`, { stripeConnectId: 'acct_real' })
    await deliver('account.updated', { id: 'acct_other', charges_enabled: true, payouts_enabled: true, metadata: { clerkUserId: OWNER } })
    expect((await read(`users/${OWNER}`))?.connectPayoutsEnabled).toBeUndefined()
    await deliver('account.updated', { id: 'acct_real', charges_enabled: true, payouts_enabled: true, details_submitted: true, metadata: { clerkUserId: OWNER } })
    expect(await read(`users/${OWNER}`)).toMatchObject({ connectPayoutsEnabled: true, connectDetailsSubmitted: true })
  })
})

describe('deposit invoice when a customer approves', () => {
  const approved = (extra: Record<string, unknown> = {}) => ({
    createdBy: OWNER, customerName: 'Pat Doe', jobTypeName: 'Deck repair', total: 4200,
    depositRequested: true, depositAmount: 1000, status: 'approved', scopeOfWork: 'Replace boards', ...extra,
  })
  beforeEach(async () => { await seed(`users/${OWNER}`, { businessName: 'Owner Co', businessPhone: '555-0100' }) })

  it('bills the deposit from the estimate on file, whatever the caller sends', async () => {
    await seed('estimates/e1', approved({ projectId: 'est_e1' }))
    const res = await deposit.post({ estimateId: 'e1', depositAmount: 1, total: 1, amountDue: 1 })
    expect(res.status).toBe(200)
    const inv = await read(`invoices/${res.json.invoiceId}`)
    expect(inv).toMatchObject({
      createdBy: OWNER, projectId: 'est_e1', estimateId: 'e1', subtotal: 1000, amountDue: 1000, amountPaid: 0,
      isDeposit: true, status: 'sent', businessName: 'Owner Co', invoiceNumber: `INV-${new Date().getFullYear()}-0001`,
    })
    expect((await read('estimates/e1'))?.depositInvoiceCreated).toBe(true)
  })

  it('a second tap gets the same invoice, including before the estimate has a project', async () => {
    await seed('estimates/e1', approved())   // no projectId yet
    const a = await deposit.post({ estimateId: 'e1' })
    const b = await deposit.post({ estimateId: 'e1' })
    expect(b.json.invoiceId).toBe(a.json.invoiceId)
    expect(await all('invoices')).toHaveLength(1)
  })

  it('finds an older deposit invoice that was stored by project only', async () => {
    await seed('estimates/e1', approved({ projectId: 'p1' }))
    await seed('invoices/old', { createdBy: OWNER, projectId: 'p1', isDeposit: true, subtotal: 1000, amountDue: 1000, amountPaid: 0, status: 'sent' })
    const res = await deposit.post({ estimateId: 'e1' })
    expect(res.json.invoiceId).toBe('old')
    expect(await all('invoices')).toHaveLength(1)
  })

  it('"pay it all now" re-prices an untouched deposit invoice, but never one with money on it', async () => {
    await seed('estimates/e1', approved({ projectId: 'p1' }))
    const first = await deposit.post({ estimateId: 'e1' })
    await deposit.post({ estimateId: 'e1', payFull: true })
    expect(await read(`invoices/${first.json.invoiceId}`)).toMatchObject({ subtotal: 4200, amountDue: 4200 })

    await clearDb()
    await seed('estimates/e1', approved({ projectId: 'p1' }))
    await seed('invoices/part', { createdBy: OWNER, projectId: 'p1', estimateId: 'e1', isDeposit: true, subtotal: 1000, amountDue: 600, amountPaid: 400, status: 'sent', payments: [{ id: 'm1', amount: 400 }] })
    await deposit.post({ estimateId: 'e1', payFull: true })
    expect(await read('invoices/part')).toMatchObject({ subtotal: 1000, amountDue: 600, amountPaid: 400 })
  })

  it('numbers the invoice one past the highest used this year', async () => {
    const y = new Date().getFullYear()
    await seed('invoices/x', { createdBy: OWNER, invoiceNumber: `INV-${y}-0007` })
    await seed('invoices/y', { createdBy: 'someone_else', invoiceNumber: `INV-${y}-0050` })
    await seed('estimates/e1', approved({ projectId: 'p1' }))
    const res = await deposit.post({ estimateId: 'e1' })
    expect((await read(`invoices/${res.json.invoiceId}`))?.invoiceNumber).toBe(`INV-${y}-0008`)
  })

  it('refuses estimates that are not approved, have no deposit, or do not exist', async () => {
    await seed('estimates/pending', approved({ status: 'pending' }))
    await seed('estimates/nodep', approved({ depositRequested: false }))
    expect((await deposit.post({ estimateId: 'pending' })).status).toBe(400)
    expect((await deposit.post({ estimateId: 'nodep' })).status).toBe(400)
    expect((await deposit.post({ estimateId: 'missing' })).status).toBe(404)
    expect((await deposit.post({})).status).toBe(400)
    expect(await deposit.get()).toBe(405)
    expect(await all('invoices')).toHaveLength(0)
  })
})

describe('card checkout for an invoice', () => {
  it('charges the balance on file, takes the 2% fee, and routes the rest to the contractor', async () => {
    await seed(`users/${OWNER}`, { stripeConnectId: 'acct_real', connectPayoutsEnabled: true })
    await seed('invoices/i1', invoice({ amountDue: 734.5, jobTypeName: 'Deck repair' }))
    const res = await checkout.post({ invoiceId: 'i1', amount: 1, amountDue: 1 })
    expect(res.status).toBe(200)
    expect(res.json.url).toBe('https://checkout.stripe.test/cs_test_123')

    expect(stripeStub.checkoutCalls).toHaveLength(1)
    const { params, options } = stripeStub.checkoutCalls[0] as unknown as {
      params: { mode: string; line_items: Array<{ price_data: { unit_amount: number; currency: string } }>; metadata: Record<string, string>; success_url: string; payment_intent_data: { application_fee_amount: number; on_behalf_of: string; transfer_data: { destination: string } } }
      options: { idempotencyKey: string }
    }
    expect(params.mode).toBe('payment')
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 73450, currency: 'usd' })
    expect(params.payment_intent_data).toMatchObject({ application_fee_amount: 1469, on_behalf_of: 'acct_real', transfer_data: { destination: 'acct_real' } })
    expect(params.metadata.invoiceId).toBe('i1')
    expect(params.success_url).toBe('https://builderspro.cc/inv/i1')
    expect(options.idempotencyKey).toBe('inv_i1_73450')
    expect((await read('invoices/i1'))?.stripeSessionId).toBe('cs_test_123')
  })

  it('never starts a checkout when the contractor cannot receive card payments', async () => {
    await seed(`users/${OWNER}`, { stripeConnectId: 'acct_real', connectPayoutsEnabled: false })
    await seed('invoices/i1', invoice())
    expect((await checkout.post({ invoiceId: 'i1' })).status).toBe(409)
    expect(stripeStub.checkoutCalls).toHaveLength(0)
  })

  it('refuses a paid invoice, a zero balance and an unknown invoice', async () => {
    await seed(`users/${OWNER}`, { stripeConnectId: 'acct_real', connectPayoutsEnabled: true })
    await seed('invoices/paid', invoice({ status: 'paid', amountDue: 0 }))
    await seed('invoices/zero', invoice({ amountDue: 0 }))
    expect((await checkout.post({ invoiceId: 'paid' })).status).toBe(409)
    expect((await checkout.post({ invoiceId: 'zero' })).status).toBe(400)
    expect((await checkout.post({ invoiceId: 'nope' })).status).toBe(404)
    expect(stripeStub.checkoutCalls).toHaveLength(0)
  })

  it('reports a Stripe failure without leaking details', async () => {
    await seed(`users/${OWNER}`, { stripeConnectId: 'acct_real', connectPayoutsEnabled: true })
    await seed('invoices/i1', invoice())
    stripeStub.checkoutError = new Error('No such destination: acct_real; request req_abc')
    const res = await checkout.post({ invoiceId: 'i1' })
    expect(res.status).toBe(500)
    expect(res.text).not.toMatch(/acct_|req_/)
  })
})
