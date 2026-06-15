import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import type { Invoice } from '../data/types'
import { PUBLIC_HOST } from './config'

const sendInvoiceCallable = httpsCallable<
  {
    clerkToken: string
    input: {
      to: string
      fromName?: string
      replyTo?: string
      subject?: string
      invoice: {
        invoiceNumber: string
        customerName: string
        jobTypeName: string
        businessName?: string
        introNote?: string
        paymentTerms?: string
        lineItems: { name: string; quantity: number; unitPrice: number; lineTotal: number }[]
        subtotal: number
        amountPaid?: number
        amountDue: number
        dueDate: string
        payUrl: string
      }
    }
  },
  { ok: boolean; emailId?: string }
>(functions, 'sendInvoiceEmail')

export function invoicePayUrl(invoiceId: string): string {
  return `${PUBLIC_HOST}/inv/${invoiceId}`
}

// Sends the customer a branded invoice email with the secure pay link. The
// contractor triggers this explicitly from the share screen (after reviewing
// the invoice). Reply-to is the contractor's business email so customer replies
// reach them, not other contractors.
export async function sendInvoiceByEmail(args: {
  clerkToken: string
  invoice: Invoice
  to: string
  fromName?: string
}): Promise<void> {
  const { clerkToken, invoice, to, fromName } = args
  const res = await sendInvoiceCallable({
    clerkToken,
    input: {
      to,
      fromName: fromName || invoice.contractorName || invoice.businessName,
      replyTo: invoice.businessEmail,
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName,
        jobTypeName: invoice.jobTypeName,
        businessName: invoice.businessName,
        introNote: invoice.introNote,
        paymentTerms: invoice.paymentTerms,
        lineItems: (invoice.lineItems || []).map(l => ({
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        subtotal: invoice.subtotal,
        amountPaid: invoice.amountPaid,
        amountDue: invoice.amountDue,
        dueDate: invoice.dueDate,
        payUrl: invoicePayUrl(invoice.id),
      },
    },
  })
  if (!res.data?.ok) throw new Error('Email send did not confirm success')
}
