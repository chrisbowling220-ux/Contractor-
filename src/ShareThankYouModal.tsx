import { useState } from 'react'
import { isPhone } from './lib/shareEstimate'
import type { ThankYouPackage } from './data/types'

const PUBLIC_HOST = 'https://contractors-office-96731.web.app'

interface Props {
  pkg: ThankYouPackage
  fromName?: string
  onClose: () => void
}

function smsHref(pkg: ThankYouPackage, fromName?: string): string {
  const link = `${PUBLIC_HOST}/thanks/${pkg.id}`
  const body = `${link}\n\nThank you for letting ${fromName || 'us'} work on your project, ${pkg.customerName}. A few photos and a note from us.`
  const enc = encodeURIComponent(body)
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return `sms:&body=${enc}`
  return `sms:?body=${enc}`
}

function mailtoHref(pkg: ThankYouPackage, fromName?: string): string {
  const link = `${PUBLIC_HOST}/thanks/${pkg.id}`
  const subject = `Thank you — your ${pkg.jobTypeName} project`
  const body = `Hi ${pkg.customerName},

A small note and a few photos from your project — thank you for trusting us with the work.

${link}

— ${fromName || 'Your contractor'}`
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export default function ShareThankYouModal({ pkg, fromName, onClose }: Props) {
  const [linkCopied, setLinkCopied] = useState(false)
  const link = `${PUBLIC_HOST}/thanks/${pkg.id}`

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
        title: `Thank you, ${pkg.customerName}`,
        text: `${link}\n\nA thank-you and photos from your ${pkg.jobTypeName} project.`,
        url: link,
      })
    } catch { /* user cancelled */ }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 300, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '480px', width: '100%', background: 'white', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ background: 'linear-gradient(135deg, #1a1f2e 0%, #0f172a 100%)', color: 'white', padding: '20px 24px' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 800, color: '#f97316' }}>🎁 Thank-You Package Ready</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>Letter + slideshow saved. Send the link to {pkg.customerName} — they tap and see it in their browser. They can save it as a PDF themselves if they want.</p>
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
              <a href={smsHref(pkg, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
                💬 Text
              </a>
            )}
            <a href={mailtoHref(pkg, fromName)} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '12px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center', display: 'inline-block' }}>
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
            The link works on any device. Customer can read in browser or print/save as PDF from there.
          </p>

          <button onClick={onClose} style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
