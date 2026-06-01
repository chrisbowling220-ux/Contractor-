import { useState } from 'react'
import { isPhone } from './lib/shareEstimate'
import type { Invoice } from './data/types'

import { PUBLIC_HOST } from './lib/config'

interface Props {
  invoice: Invoice
  fromName?: string
  onClose: () => void
}

function smsHref(inv: Invoice, fromName?: string): string {
  const link = `${PUBLIC_HOST}/inv/${inv.id}`
  const body = `${link}\n\nInvoice ${inv.invoiceNumber} from ${fromName || 'your contractor'} — $${inv.amountDue.toFixed(2)} due.`
  const enc = encodeURIComponent(body)
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return `sms:&body=${enc}`
  return `sms:?body=${enc}`
}

function mailtoHref(inv: Invoice, fromName?: string): string {
  const link = `${PUBLIC_HOST}/inv/${inv.id}`
  const subject = `Invoice ${inv.invoiceNumber} — ${inv.jobTypeName}`
  const recipient = inv.customerEmail || ''
  const body = `Hi ${inv.customerName},

Please find your invoice attached for ${inv.jobTypeName}:

${link}

Amount due: $${inv.amountDue.toFixed(2)}
Due by: ${new Date(inv.dueDate).toLocaleDateString()}

— ${fromName || inv.businessName || 'Your contractor'}`
  return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export default function ShareInvoiceModal({ invoice, fromName, onClose }: Props) {
  const [linkCopied, setLinkCopied] = useState(false)
  const link = `${PUBLIC_HOST}/inv/${invoice.id}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    } catch {
      alert(`Copy failed. Manual link: ${link}`)
    }
  }

  const handleNativeShare = async () => {
    if (typeof navigator === 'undefined' || !navigator.share) {
      await handleCopy()
      return
    }
    try {
      await navigator.share({
        title: `Invoice ${invoice.invoiceNumber}`,
        text: `${link}\n\nInvoice ${invoice.invoiceNumber} — $${invoice.amountDue.toFixed(2)} due.`,
        url: link,
      })
    } catch { /* user cancelled */ }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 300, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '480px', width: '100%', background: 'white', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ background: 'linear-gradient(135deg, #1a1f2e 0%, #0f172a 100%)', color: 'white', padding: '16px 20px', position: 'sticky', top: 0, zIndex: 10 }}>
          <button onClick={onClose} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>
            ← Back to Project
          </button>
          <h2 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 800, color: '#f97316' }}>🧾 Invoice {invoice.invoiceNumber}</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>
            ${invoice.amountDue.toFixed(2)} due from {invoice.customerName}.
          </p>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', wordBreak: 'break-all', fontSize: '12px', color: '#475569', fontFamily: 'ui-monospace, monospace' }}>
            {link}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {isPhone() && (
              <button onClick={handleNativeShare} style={{ flex: '1 1 auto', background: '#0ea5e9', color: 'white', border: 'none', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
                📤 Share
              </button>
            )}
            {isPhone() && (
              <a href={smsHref(invoice, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
                💬 Text
              </a>
            )}
            <a href={mailtoHref(invoice, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
              ✉️ Email
            </a>
            <button onClick={handleCopy} style={{ flex: '1 1 auto', background: '#16a34a', color: 'white', border: 'none', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
              {linkCopied ? '✓ Copied' : '🔗 Copy link'}
            </button>
            <a href={link} target="_blank" rel="noopener noreferrer" style={{ flex: '1 1 auto', background: '#1a1f2e', color: 'white', border: 'none', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', textAlign: 'center', display: 'inline-block' }}>
              👁️ Preview
            </a>
          </div>

          <p style={{ margin: '14px 0 0', fontSize: '11px', color: '#94a3b8', textAlign: 'center' }}>
            Customer taps the link, sees the invoice in their browser, can print or save as PDF.
          </p>

          <button onClick={onClose} style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
