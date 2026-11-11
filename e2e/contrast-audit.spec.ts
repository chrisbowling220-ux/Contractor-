import { test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { resetData, seed, seedContractor, signIn, UID } from './helpers'
test('contrast audit (report only)', async ({ page }) => {
  await resetData(); await seedContractor()
  await seed('estimates/e1', { createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', description: 'x', rateType: 'hourly', hourlyRate: 70, estimatedHours: 10, laborTotal: 700, materials: [], materialsTotal: 0, rentals: [], rentalsTotal: 0, jobLocationZip: '27573', total: 1200, scopeOfWork: 'Scope', status: 'pending', depositRequested: true, depositAmount: 300, proposedStartDate: '2026-12-01', createdAt: new Date().toISOString() })
  await seed('changeOrders/co1', { createdBy: UID, projectId: 'p1', customerName: 'Pat Doe', description: 'Handrail', reason: 'customer_requested', lineItems: [{ name: 'Handrail', quantity: 1, unitPrice: 350, lineTotal: 350 }], originalTotal: 1200, delta: 350, newTotal: 1550, status: 'pending', createdAt: new Date().toISOString() })
  await seed('invoices/open', { createdBy: UID, customerName: 'Pat Doe', jobTypeName: 'Deck repair', invoiceNumber: 'INV-2026-0007', introNote: 'Thanks', paymentTerms: 'Due in 14 days.', lineItems: [{ name: 'Item', quantity: 1, unitPrice: 1200, lineTotal: 1200 }], subtotal: 1200, amountPaid: 500, amountDue: 700, status: 'sent', payments: [{ id: 'p1', amount: 500, method: 'check', date: '2026-11-05', recordedAt: '', source: 'manual' }], dueDate: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date().toISOString() })
  const seen = new Map<string, number>()
  const scan = async (label: string) => {
    const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
    for (const v of r.violations) for (const n of v.nodes) {
      const m = /foreground color: (#\w+), background color: (#\w+).*?ratio of ([\d.]+)/.exec(n.any[0]?.message || '')
      const key = `${label}  fg ${m?.[1]} on ${m?.[2]} = ${m?.[3]}`
      seen.set(key, (seen.get(key) || 0) + 1)
    }
  }
  for (const [u, l] of [['/', 'landing'], ['/q/e1', 'estimate'], ['/co/co1', 'changeorder'], ['/inv/open', 'invoice'], ['/terms', 'terms'], ['/safe-to-spend', 'safe-to-spend']] as const) { await page.goto(u); await page.waitForTimeout(1200); await scan(l) }
  await signIn(page); await scan('dashboard')
  for (const [k, n] of [...seen].sort()) console.log(`CONTRAST ${n}x ${k}`)
})
