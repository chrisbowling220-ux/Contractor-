// Email and AI features on the server side: who may call them, what they
// send, how the free allowance is charged and refunded. No real email is sent
// and no real model is called (see mocks.ts / harness.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import { ai, aiMessage } from './mocks'
import { call, callRaw, clearDb, failsWith, outbound, outboundReply, read, seed } from './harness'
import {
  sendEstimateEmail, sendInvoiceEmail, generateAIQuote, generateThankYouLetter,
  generateInvoiceCopy, exchangeFirebaseToken, onInvoicePaidAlert, onEstimateResponded,
} from '../src/index'

const USER = 'user_contractor'
const today = () => new Date().toISOString().slice(0, 10)

beforeEach(async () => {
  await clearDb()
  outbound.length = 0
  outboundReply.status = 200
  ai.next = null
  ai.calls.length = 0
})

describe('signing in', () => {
  it('every protected function refuses a missing or invalid sign-in token', async () => {
    await failsWith(callRaw(exchangeFirebaseToken, {}), 'unauthenticated')
    await failsWith(callRaw(exchangeFirebaseToken, { clerkToken: 'forged' }), 'unauthenticated')
    await failsWith(callRaw(generateAIQuote, { clerkToken: 'forged', input: { customerName: 'x', jobTypeName: 'y' } }), 'unauthenticated')
    await failsWith(callRaw(sendEstimateEmail, { clerkToken: 'forged', input: { to: 'a@example.com', estimate: { jobTypeName: 'x', total: 1 } } }), 'unauthenticated')
    expect(ai.calls).toHaveLength(0)
    expect(outbound).toHaveLength(0)
  })
})

describe('estimate email', () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    to: 'pat@example.com', fromName: 'Owner Co', replyTo: 'office@ownerco.example',
    estimate: { customerName: 'Pat <b>Doe</b>', jobTypeName: 'Deck repair', total: 4200, scopeOfWork: 'Replace boards' },
    ...extra,
  })

  it('sends from our domain with the contractor as reply-to, and escapes customer text', async () => {
    const res = await call<{ ok: boolean; emailId: string }>(sendEstimateEmail, USER, input())
    expect(res).toEqual({ ok: true, emailId: 'email_test_1' })
    expect(outbound).toHaveLength(1)
    const { url, body } = outbound[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(body.from).toBe('Owner Co <alerts@builderspro.cc>')
    expect(body.to).toEqual(['pat@example.com'])
    expect(body.reply_to).toBe('office@ownerco.example')
    expect(String(body.html)).toContain('$4200.00')
    expect(String(body.html)).not.toContain('<b>Doe</b>')
    expect((await read(`emailUsage/${USER}/days/${today()}`))?.count).toBe(1)
  })

  it('an AI quote is emailed as the customer sees it: no markup line, same total', async () => {
    const aiQuote = {
      customer_summary: 'Deck boards', work_scope: 'Replace boards',
      material_list: [{ name: 'Board', base_quantity: 10, waste_percent: 0, quantity_with_waste: 10, quantity_math: '', unit: 'each', unit_price: 12, line_total: 120 }],
      labor: { estimated_hours: 2, breakdown: '', hourly_rate: 50, labor_total: 100 },
      price_breakdown: { labor_subtotal: 100, materials_subtotal: 120, rentals_subtotal: 0, raw_cost: 220 },
      profit_markup: { markup_percent: 0, markup_dollars: 0, rationale: '' },
      final_customer_quote: 220, contractor_notes: '',
    }
    await call(sendEstimateEmail, USER, input({ estimate: { customerName: 'Pat', jobTypeName: 'Deck', total: 220, scopeOfWork: 'x', aiQuote } }))
    const html = String(outbound[0].body.html)
    expect(html).toContain('$220.00')
    expect(html).not.toMatch(/Markup/i)
  })

  it('strips line breaks and angle brackets a caller could use to forge headers', async () => {
    await call(sendEstimateEmail, USER, input({
      fromName: 'Owner Co\r\nBcc: victim@example.com <x>', subject: 'Your estimate\nBcc: someone@example.com', replyTo: 'not-an-address',
    }))
    const { body } = outbound[0]
    expect(String(body.from)).not.toMatch(/[\r\n]/)
    expect(String(body.from).match(/</g)).toHaveLength(1)
    expect(String(body.subject)).not.toMatch(/[\r\n]/)
    expect(body.reply_to).toBeUndefined()
  })

  it('rejects a bad address before anything is sent or counted', async () => {
    await failsWith(call(sendEstimateEmail, USER, input({ to: 'not an email' })), 'invalid-argument')
    expect(outbound).toHaveLength(0)
    expect(await read(`emailUsage/${USER}/days/${today()}`)).toBeUndefined()
  })

  it('stops at the daily limit, per contractor', async () => {
    await seed(`emailUsage/${USER}/days/${today()}`, { count: 60 })
    const msg = await failsWith(call(sendEstimateEmail, USER, input()), 'resource-exhausted')
    expect(msg).toMatch(/limit of 60/)
    expect(outbound).toHaveLength(0)
    // Someone else is unaffected.
    await call(sendEstimateEmail, 'user_other', input())
    expect(outbound).toHaveLength(1)
  })

  it('reports a failed send as a failure', async () => {
    outboundReply.status = 500
    await failsWith(call(sendEstimateEmail, USER, input()), 'internal')
  })
})

describe('invoice email', () => {
  const input = (payUrl: string) => ({
    to: 'pat@example.com', fromName: 'Owner Co',
    invoice: {
      invoiceNumber: 'INV-2026-0007', customerName: 'Pat Doe', jobTypeName: 'Deck repair', businessName: 'Owner Co',
      lineItems: [{ name: 'Labor', quantity: 1, unitPrice: 700, lineTotal: 700 }],
      subtotal: 700, amountPaid: 0, amountDue: 700, dueDate: '2026-12-01T00:00:00.000Z', payUrl,
    },
  })
  it('sends with a pay link to our own site', async () => {
    await call(sendInvoiceEmail, USER, input('https://builderspro.cc/inv/abc123'))
    expect(outbound).toHaveLength(1)
    expect(String(outbound[0].body.html)).toContain('https://builderspro.cc/inv/abc123')
    expect(String(outbound[0].body.html)).toContain('$700.00')
  })
  it('refuses a pay link that points anywhere else', async () => {
    for (const bad of ['https://evil.example/inv/abc', 'https://builderspro.cc.evil.example/inv/abc', 'javascript:alert(1)', '']) {
      await failsWith(call(sendInvoiceEmail, USER, input(bad)), 'invalid-argument')
    }
    expect(outbound).toHaveLength(0)
  })
})

describe('AI quote: allowance, refunds and failures', () => {
  const job = {
    customerName: 'Pat Doe', jobTypeName: 'Deck repair', description: 'Replace rotted boards',
    jobLocationZip: '27573', jobLocationRegion: 'NC', regionMultiplier: 1, rateType: 'hourly',
    hourlyRate: 70, estimatedHours: 10, laborTotal: 700, materials: [], rentals: [],
  }
  const quote = { customer_summary: 'Deck repair', final_customer_quote: 1200 }

  it('a free account spends one of its ten and gets the quote back', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 3 })
    ai.next = aiMessage(quote)
    expect(await call(generateAIQuote, USER, job)).toEqual(quote)
    expect((await read(`users/${USER}`))?.aiQuotesUsed).toBe(4)
    expect(ai.calls).toHaveLength(1)
    // The contractor's job details reach the model; nothing about billing does.
    expect(JSON.stringify(ai.calls[0].messages)).toContain('Replace rotted boards')
  })

  it('out of free quotes and credits: refused before any model call', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 10, paidQuoteCredits: 0 })
    ai.next = aiMessage(quote)
    const msg = await failsWith(call(generateAIQuote, USER, job), 'resource-exhausted')
    expect(msg).toMatch(/out of instant quotes/i)
    expect(ai.calls).toHaveLength(0)
  })

  it('after the free ten, a paid credit is spent', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 10, paidQuoteCredits: 2 })
    ai.next = aiMessage(quote)
    await call(generateAIQuote, USER, job)
    expect(await read(`users/${USER}`)).toMatchObject({ aiQuotesUsed: 10, paidQuoteCredits: 1 })
  })

  it('Pro is unlimited and leaves the free allowance untouched', async () => {
    await seed(`users/${USER}`, { tier: 'pro', aiQuotesUsed: 10, proQuotesUsed: 40 })
    ai.next = aiMessage(quote)
    await call(generateAIQuote, USER, job)
    expect(await read(`users/${USER}`)).toMatchObject({ aiQuotesUsed: 10, proQuotesUsed: 41 })
  })

  it('a failed quote is refunded and the error names no provider or billing detail', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 3, paidQuoteCredits: 0 })
    ai.next = Object.assign(new Error('Your credit balance is too low to access the Anthropic API'), { status: 400, error: { type: 'invalid_request_error' } })
    const msg = await failsWith(call(generateAIQuote, USER, job), 'unavailable')
    expect(msg).not.toMatch(/anthropic|claude|credit balance|api/i)
    expect((await read(`users/${USER}`))?.aiQuotesUsed).toBe(3)
  })

  it('a paid credit is refunded too', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 10, paidQuoteCredits: 2 })
    ai.next = Object.assign(new Error('bad request'), { status: 400 })
    await failsWith(call(generateAIQuote, USER, job), 'unavailable')
    expect((await read(`users/${USER}`))?.paidQuoteCredits).toBe(2)
  })

  it('a cut-off or refused answer is reported plainly, and refunded', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 0 })
    ai.next = aiMessage(quote, { stop_reason: 'max_tokens' })
    expect(await failsWith(call(generateAIQuote, USER, job), 'internal')).toMatch(/longer than expected/)
    ai.next = aiMessage(quote, { stop_reason: 'refusal' })
    await failsWith(call(generateAIQuote, USER, job), 'invalid-argument')
    ai.next = { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: '{"customer_summary": "Deck' }] }
    expect(await failsWith(call(generateAIQuote, USER, job), 'internal')).toMatch(/incomplete/)
    expect((await read(`users/${USER}`))?.aiQuotesUsed).toBe(0)
  })

  it('missing job details are rejected without spending anything', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 0 })
    await failsWith(call(generateAIQuote, USER, { customerName: '', jobTypeName: '' }), 'invalid-argument')
    expect((await read(`users/${USER}`))?.aiQuotesUsed).toBe(0)
  })
})

describe('other AI features', () => {
  it('thank-you letters are Pro only, and a free account never reaches the model', async () => {
    await seed(`users/${USER}`, { tier: 'free' })
    ai.next = aiMessage({ greeting: 'Dear Pat,' })
    await failsWith(call(generateThankYouLetter, USER, { customerName: 'Pat Doe', jobTypeName: 'Deck repair' }), 'permission-denied')
    expect(ai.calls).toHaveLength(0)

    await seed(`users/${USER}`, { tier: 'pro' })
    expect(await call(generateThankYouLetter, USER, { customerName: 'Pat Doe', jobTypeName: 'Deck repair' })).toEqual({ greeting: 'Dear Pat,' })
  })

  it('invoice notes are free and do not touch the quote allowance', async () => {
    await seed(`users/${USER}`, { tier: 'free', aiQuotesUsed: 10 })
    ai.next = aiMessage({ intro_note: 'Thanks!', payment_terms: 'Due in 14 days.' })
    expect(await call(generateInvoiceCopy, USER, { customerName: 'Pat Doe', jobTypeName: 'Deck repair', total: 1200 }))
      .toEqual({ intro_note: 'Thanks!', payment_terms: 'Due in 14 days.' })
    expect((await read(`users/${USER}`))?.aiQuotesUsed).toBe(10)
  })
})

describe('"invoice paid" email to the contractor', () => {
  const OWNER = 'user_paid_owner'
  const fire = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    (onInvoicePaidAlert as unknown as { run: (e: unknown) => Promise<unknown> }).run({
      params: { id: 'inv1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    })
  const base = { createdBy: OWNER, customerName: 'Pat Doe', invoiceNumber: 'INV-2026-0007', subtotal: 1200, status: 'sent' }
  const pay = (amount: number, method: string, source: 'manual' | 'stripe', date = '2026-11-19') => ({ id: `p${amount}`, amount, method, date, recordedAt: '', source })
  const sent = () => {
    expect(outbound).toHaveLength(1)
    expect(outbound[0].url).toContain('api.resend.com')
    const { subject, html, to } = outbound[0].body as { subject: string; html: string; to: string[] }
    expect(to).toEqual(['owner@example.test'])
    return { subject, html }
  }
  beforeEach(async () => { await seed(`users/${OWNER}`, { businessEmail: 'owner@example.test', businessName: 'Owner Co' }) })

  it('cash recorded in the app is never called a card payment or a bank transfer', async () => {
    await fire(base, { ...base, status: 'paid', payments: [pay(1200, 'cash', 'manual')] })
    const { subject, html } = sent()
    expect(subject).toBe('✅ Invoice INV-2026-0007 for Pat Doe is paid in full')
    expect(html).toContain('$1,200.00 by cash, was recorded in the app')
    expect(`${subject} ${html}`).not.toMatch(/card|bank|Stripe|on its way|on their way/i)
  })

  it('a check, after an earlier part payment, lists both and says paid in full', async () => {
    await fire(base, { ...base, status: 'paid', payments: [pay(500, 'check', 'manual', '2026-11-12'), pay(700, 'check', 'manual')] })
    const { subject, html } = sent()
    expect(subject).toContain('is paid in full')
    expect(html).toContain('The last payment, $700.00 by check')
    expect(html).toContain('Payments: $500.00 by check, recorded in the app on 2026-11-12; $700.00 by check, recorded in the app on 2026-11-19.')
    expect(`${subject} ${html}`).not.toMatch(/card|bank|Stripe|on its way/i)
  })

  it('a card payment taken online says card, and only then mentions the bank', async () => {
    await fire(base, { ...base, status: 'paid', payments: [pay(400, 'check', 'manual', '2026-11-12'), pay(800, 'card', 'stripe')] })
    const { subject, html } = sent()
    expect(subject).toBe('💳 Pat Doe paid invoice INV-2026-0007 by card')
    expect(html).toContain('paid $800.00 by card online')
    expect(html).toContain('$400.00 by check, recorded in the app')
    expect(html).toContain('The card payment is on its way to your bank through Stripe.')
  })

  it('an invoice with no payment history is only "marked paid", with no method claimed', async () => {
    await fire(base, { ...base, status: 'paid' })
    const { subject, html } = sent()
    expect(subject).toBe('✅ Invoice INV-2026-0007 for Pat Doe is marked paid')
    expect(`${subject} ${html}`).not.toMatch(/card|cash|check|bank|Stripe/i)
  })

  it('names other recorded methods as they are, and escapes what the customer typed', async () => {
    await fire(base, { ...base, customerName: '<b>Pat</b>', status: 'paid', payments: [pay(1200, 'zelle', 'manual')] })
    const { html } = sent()
    expect(html).toContain('by Zelle, was recorded in the app')
    expect(html).toContain('&lt;b&gt;Pat&lt;/b&gt;')
    expect(html).not.toMatch(/bank|Stripe/)
  })

  it('sends nothing for a part payment, a re-save of a paid invoice, or an owner with no email', async () => {
    await fire(base, { ...base, amountPaid: 500, payments: [pay(500, 'cash', 'manual')] })
    await fire({ ...base, status: 'paid' }, { ...base, status: 'paid', payments: [pay(1200, 'cash', 'manual')] })
    await fire(base, { ...base, createdBy: 'user_without_profile', status: 'paid', payments: [pay(1200, 'cash', 'manual')] })
    expect(outbound).toHaveLength(0)
  })

  it('the "will pay cash" choice email is unchanged', async () => {
    await fire(base, { ...base, customerCashChoice: true })
    const { subject, html } = sent()
    expect(subject).toBe('💵 Pat Doe will pay cash for invoice INV-2026-0007')
    expect(html).toContain('chose to pay invoice INV-2026-0007 ($1,200) in cash/in person.')
  })
})

describe('"estimate approved" email to the contractor', () => {
  const OWNER = 'user_est_owner'
  const fire = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    (onEstimateResponded as unknown as { run: (e: unknown) => Promise<unknown> }).run({
      params: { id: 'e1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    })
  const pending = { createdBy: OWNER, customerName: 'Pat Doe', jobTypeName: 'Deck repair', total: 1200, status: 'pending' }
  const approve = (extra: Record<string, unknown> = {}) =>
    fire({ ...pending, ...extra }, { ...pending, ...extra, status: 'approved', customerResponse: { action: 'approved', signedName: 'Pat Doe' } })
  const sent = () => {
    expect(outbound).toHaveLength(1)
    const { subject, html, to } = outbound[0].body as { subject: string; html: string; to: string[] }
    expect(to).toEqual(['owner@example.test'])
    expect(subject).toBe('✅ Pat Doe approved your estimate')
    expect(html).toContain('just <strong>approved</strong> the Deck repair estimate ($1,200).')
    expect(html).toContain('Signed by Pat Doe.')
    return html
  }
  beforeEach(async () => { await seed(`users/${OWNER}`, { businessEmail: 'owner@example.test', businessName: 'Owner Co' }) })

  it('a job that is in Projects says so, as before', async () => {
    await seed('projects/p1', { createdBy: OWNER, status: 'estimated' })
    await approve({ projectId: 'p1' })
    const html = sent()
    expect(html).toContain("It's now in your Projects, ready to go.")
    expect(html).not.toContain('deleted')
  })

  it('a deleted project is not called "in your Projects"; it says where the signed estimate is', async () => {
    await approve({ projectId: 'gone' })
    const html = sent()
    expect(html).not.toContain('now in your Projects')
    expect(html).toContain("This estimate's project was deleted, so it is not in your Projects. The signed estimate is under Estimates → Approved.")
    expect(html).not.toContain('deposit')            // none was asked for
    expect(await read('projects/gone')).toBeUndefined()   // and nothing is brought back
  })

  it('with a deposit asked, it says no deposit invoice was made and what the customer was told', async () => {
    await approve({ projectId: 'gone', depositRequested: true, depositAmount: 300 })
    const html = sent()
    expect(html).toContain('No deposit invoice was made for it, so the customer has nothing to pay yet.')
    expect(html).toContain("Their page tells them you'll send the deposit invoice.")
  })

  it('a project id that belongs to another contractor counts as deleted', async () => {
    await seed('projects/theirs', { createdBy: 'someone_else', status: 'in_progress' })
    await approve({ projectId: 'theirs' })
    expect(sent()).toContain("This estimate's project was deleted")
  })

  it('an estimate with no project yet keeps the usual wording (the app makes its project)', async () => {
    await approve()
    expect(sent()).toContain("It's now in your Projects, ready to go.")
  })

  it('escapes what the customer typed', async () => {
    await fire({ ...pending, projectId: 'gone' }, { ...pending, projectId: 'gone', status: 'approved', customerResponse: { action: 'approved', signedName: '<i>Pat</i>' } })
    expect(String((outbound[0].body as { html: string }).html)).toContain('Signed by &lt;i&gt;Pat&lt;/i&gt;.')
  })

  it('the decline email is unchanged, and later edits send nothing', async () => {
    await fire(pending, { ...pending, projectId: 'gone', status: 'declined', customerResponse: { action: 'declined', signedName: 'Pat Doe', reason: 'Too much' } })
    expect(outbound).toHaveLength(1)
    const { subject, html } = outbound[0].body as { subject: string; html: string }
    expect(subject).toBe('Pat Doe declined your estimate')
    expect(html).toContain('Reason: Too much')
    expect(html).toContain('You can adjust it and re-send anytime.')
    outbound.length = 0
    await fire({ ...pending, status: 'approved' }, { ...pending, status: 'approved', total: 1300 })
    expect(outbound).toHaveLength(0)
  })
})
