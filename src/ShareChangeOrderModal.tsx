import { useState } from 'react'
import { isPhone } from './lib/shareEstimate'
import type { ChangeOrder } from './data/types'

const PUBLIC_HOST = 'https://contractors-office-96731.web.app'

interface Props {
  changeOrder: ChangeOrder
  fromName?: string
  onClose: () => void
}

function smsHref(co: ChangeOrder, fromName?: string): string {
  const link = `${PUBLIC_HOST}/co/${co.id}`
  const body = `${link}\n\nChange order from ${fromName || 'your contractor'} for ${co.customerName}.`
  const enc = encodeURIComponent(body)
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return `sms:&body=${enc}`
  return `sms:?body=${enc}`
}

function mailtoHref(co: ChangeOrder, fromName?: string): string {
  const link = `${PUBLIC_HOST}/co/${co.id}`
  const subject = `Change order for your project`
  const body = `Hi ${co.customerName},

There's a change order on your project for review and approval:

${link}

— ${fromName || 'Your contractor'}`
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

// Auto-popup that appears immediately after a change order is created so the
// contractor can fire it off to the customer in one click.
export default function ShareChangeOrderModal({ changeOrder, fromName, onClose }: Props) {
  const [linkCopied, setLinkCopied] = useState(false)
  const link = `${PUBLIC_HOST}/co/${changeOrder.id}`

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
        title: `Change order for ${changeOrder.customerName}`,
        text: `${link}\n\nChange order from ${fromName || 'your contractor'} for ${changeOrder.customerName}.`,
        url: link,
      })
    } catch {
      // User cancelled — no-op.
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 300, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '480px', width: '100%', background: 'white', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ background: 'linear-gradient(135deg, #1a1f2e 0%, #0f172a 100%)', color: 'white', padding: '20px 24px' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 800, color: '#f97316' }}>✅ Change Order Created</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>Send it to {changeOrder.customerName} for approval. They sign with their name to accept.</p>
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
              <a href={smsHref(changeOrder, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
                💬 Text
              </a>
            )}
            <a href={mailtoHref(changeOrder, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
              ✉️ Email
            </a>
            <button onClick={handleCopy} style={{ flex: '1 1 auto', background: '#16a34a', color: 'white', border: 'none', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
              {linkCopied ? '✓ Copied' : '🔗 Copy link'}
            </button>
          </div>

          <p style={{ margin: '14px 0 0', fontSize: '11px', color: '#94a3b8', textAlign: 'center' }}>
            Customer-facing view — your markup is baked in, no markup line shown.
          </p>

          <button onClick={onClose} style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
