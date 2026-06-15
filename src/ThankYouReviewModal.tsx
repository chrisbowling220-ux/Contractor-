import { useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { isPhone } from './lib/shareEstimate'
import type { ThankYouPackage } from './data/types'

import { PUBLIC_HOST } from './lib/config'

interface Props {
  pkg: ThankYouPackage
  fromName?: string
  // Regenerate the letter with (optionally) new instructions. Returns the new
  // letter so we can show it for further editing.
  onRegenerate: (highlights: string) => Promise<ThankYouPackage['letter']>
  onClose: () => void
}

// Review → edit → regenerate → share, for a generated thank-you letter.
// The contractor can hand-edit any part of the letter, OR add instructions and
// regenerate it (honored by the model), then send via SMS/email/copy/preview.
export default function ThankYouReviewModal({ pkg, fromName, onRegenerate, onClose }: Props) {
  const [letter, setLetter] = useState(pkg.letter)
  const [highlights, setHighlights] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const link = `${PUBLIC_HOST}/thanks/${pkg.id}`

  const persist = async (next: ThankYouPackage['letter']) => {
    setSaving(true)
    try {
      await updateDoc(doc(db, 'thankYouPackages', pkg.id), { letter: next })
      setSavedNote('✓ Saved')
      setTimeout(() => setSavedNote(''), 2000)
    } catch (err) {
      setSavedNote('⚠ ' + (err instanceof Error ? err.message : 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      const next = await onRegenerate(highlights.trim())
      setLetter(next)
      await persist(next)
    } catch (err) {
      alert('Could not regenerate: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setRegenerating(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    } catch {
      alert(`Copy failed. Manual link: ${link}`)
    }
  }

  const smsHref = () => {
    const body = `${link}\n\nA thank-you note from ${fromName || 'your contractor'}.`
    const enc = encodeURIComponent(body)
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? `sms:&body=${enc}` : `sms:?body=${enc}`
  }
  const mailtoHref = () => {
    const subject = `Thank you, ${pkg.customerName}`
    const body = `Hi ${pkg.customerName},\n\n${link}\n\n— ${fromName || pkg.contractorBusiness || 'Your contractor'}`
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  const fieldLabel: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }
  const field: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }

  // In-app preview — renders the letter exactly as the customer will see it,
  // using the CURRENT (possibly unsaved) edits. No new tab / external page, so
  // it always loads, and the Back button reliably returns to the edit screen.
  if (showPreview) {
    const today = pkg.createdAt ? new Date(pkg.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''
    const photos = pkg.photos || []
    const card: React.CSSProperties = { background: 'white', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', marginBottom: '16px' }
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#f8fafc', zIndex: 400, overflowY: 'auto' }}>
        {/* Sticky back bar — always reachable while scrolling the preview */}
        <div style={{ position: 'sticky', top: 0, background: '#1a1f2e', color: 'white', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', zIndex: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setShowPreview(false)} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>← Back</button>
          <span style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Preview — what {pkg.customerName?.split(' ')[0] || 'your customer'} will see</span>
        </div>

        <div style={{ maxWidth: '720px', margin: '0 auto', padding: 'clamp(16px, 4vw, 32px) clamp(12px, 3vw, 24px)' }}>
          {/* Letterhead + letter */}
          <div style={{ ...card, padding: 'clamp(24px, 5vw, 48px)', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '3px solid #f97316', paddingBottom: '12px', marginBottom: '28px', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '40px', height: '40px', background: '#f97316', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '22px' }}>
                  {pkg.contractorBusiness?.trim()?.[0]?.toUpperCase() || 'B'}
                </div>
                <div>
                  <div style={{ fontSize: '17px', fontWeight: 800, color: '#1a1f2e', letterSpacing: '-0.5px' }}>{pkg.contractorBusiness?.trim() || 'BuildPro+'}</div>
                  <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '1px', textTransform: 'uppercase' }}>Powered by BuildPro+</div>
                </div>
              </div>
              <div style={{ color: '#64748b', fontSize: '13px' }}>{today}</div>
            </div>
            <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: 1.7, fontSize: '15px', color: '#1a1f2e' }}>
              <p style={{ fontSize: '16px', margin: '0 0 16px' }}>{letter.greeting}</p>
              <p style={{ margin: '0 0 16px' }}>{letter.opening}</p>
              <div style={{ whiteSpace: 'pre-wrap', margin: '0 0 32px' }}>{letter.body}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{letter.closing}</div>
            </div>
            <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '1px solid #e2e8f0', textAlign: 'center', color: '#94a3b8', fontSize: '11px' }}>
              RE: {pkg.jobTypeName}{pkg.jobLocationZip ? ` · ZIP ${pkg.jobLocationZip}` : ''}
            </div>
          </div>

          {/* Photos */}
          {photos.length > 0 && (
            <div style={{ ...card, padding: 'clamp(24px, 5vw, 40px)', marginBottom: '20px', textAlign: 'center' }}>
              <h2 style={{ fontSize: 'clamp(22px, 5vw, 30px)', color: '#1a1f2e', margin: '0 0 8px', letterSpacing: '-0.5px' }}>A look at <span style={{ color: '#f97316' }}>your project</span></h2>
              <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>{photos.length} photo{photos.length === 1 ? '' : 's'}</p>
            </div>
          )}
          {photos.map((p, i) => (
            <div key={i} style={{ ...card, padding: '20px' }}>
              <img src={p.photoUrl} alt={p.caption || `Photo ${i + 1}`} style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '6px', background: '#000', display: 'block' }} />
              {p.caption && <p style={{ margin: '14px 0 4px', fontSize: '15px', color: '#1a1f2e', fontStyle: 'italic', textAlign: 'center' }}>{p.caption}</p>}
            </div>
          ))}

          <div style={{ textAlign: 'center', padding: '8px 0 32px' }}>
            <button onClick={() => setShowPreview(false)} style={{ background: 'transparent', border: '1px solid #cbd5e1', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', color: '#475569', fontWeight: 600 }}>← Back to edit</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '640px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>🎁 Review Thank-You Letter</h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>Edit the text, or regenerate with instructions. Then send.</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: 'white', border: '1px solid #475569', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}>← Back</button>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Editable letter fields */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
            <label style={fieldLabel}>Greeting</label>
            <input value={letter.greeting} onChange={e => setLetter({ ...letter, greeting: e.target.value })} style={{ ...field, marginBottom: '12px' }} />
            <label style={fieldLabel}>Opening</label>
            <textarea value={letter.opening} onChange={e => setLetter({ ...letter, opening: e.target.value })} rows={2} style={{ ...field, marginBottom: '12px' }} />
            <label style={fieldLabel}>Body</label>
            <textarea value={letter.body} onChange={e => setLetter({ ...letter, body: e.target.value })} rows={8} style={{ ...field, marginBottom: '12px' }} />
            <label style={fieldLabel}>Closing</label>
            <textarea value={letter.closing} onChange={e => setLetter({ ...letter, closing: e.target.value })} rows={3} style={field} />
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
              <button onClick={() => persist(letter)} disabled={saving} style={{ background: saving ? '#cbd5e1' : '#1a1f2e', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
                {saving ? 'Saving…' : '💾 Save edits'}
              </button>
              {savedNote && <span style={{ fontSize: '13px', color: savedNote.startsWith('✓') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{savedNote}</span>}
            </div>
          </div>

          {/* Regenerate with instructions */}
          <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
            <label style={fieldLabel}>Regenerate with instructions (optional)</label>
            <textarea
              value={highlights}
              onChange={e => setHighlights(e.target.value)}
              rows={3}
              placeholder="Tell it what to add or change — e.g. 'Mention the custom tile work and offer a free check-in next spring.' These will be included."
              style={{ ...field, marginBottom: '10px' }}
            />
            <button onClick={handleRegenerate} disabled={regenerating} style={{ background: regenerating ? '#cbd5e1' : '#7c3aed', color: 'white', border: 'none', padding: '9px 16px', borderRadius: '6px', cursor: regenerating ? 'default' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
              {regenerating ? '✨ Regenerating…' : '✨ Regenerate letter'}
            </button>
          </div>

          {/* Share */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
            <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#64748b', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>{link}</p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {isPhone() && <a href={smsHref()} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 12px', borderRadius: '8px', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center' }}>💬 Text</a>}
              <a href={mailtoHref()} style={{ flex: '1 1 auto', background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 12px', borderRadius: '8px', fontWeight: 700, textDecoration: 'none', color: '#1a1f2e', textAlign: 'center' }}>✉️ Email</a>
              <button onClick={handleCopy} style={{ flex: '1 1 auto', background: '#16a34a', color: 'white', border: 'none', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>{linkCopied ? '✓ Copied' : '🔗 Copy link'}</button>
              <button onClick={() => setShowPreview(true)} style={{ flex: '1 1 auto', background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>👁️ Preview</button>
            </div>
          </div>

          <button onClick={onClose} style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
