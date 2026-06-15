import { useState, useEffect, useRef } from 'react'
import { db, storage } from './firebase'
import { collection, addDoc, getDocs, query, where, doc, deleteDoc, updateDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useUser } from '@clerk/clerk-react'
import { copyShareLink, isPhone } from './lib/shareEstimate'
import type { CustomerPhoto } from './data/types'
import { PUBLIC_HOST } from './lib/config'
import { fetchCustomerDocuments, type CustomerDocument } from './lib/customerDocuments'

interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
}

interface Props {
  customer: Customer
  onBack: () => void
}

// The public share link for a customer's photo log lives at /log/<customerId>.
function logShareLink(customerId: string): string {
  return `${PUBLIC_HOST}/log/${customerId}`
}

function logSmsHref(customer: Customer): string {
  const link = logShareLink(customer.id)
  // Link-first body — survives iPhone→Android SMS carrier truncation.
  const body = `${link}\n\nProgress photo log for ${customer.name}.`
  const encoded = encodeURIComponent(body)
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return `sms:&body=${encoded}`
  }
  return `sms:?body=${encoded}`
}

function logMailtoHref(customer: Customer, fromName?: string): string {
  const link = logShareLink(customer.id)
  const subject = `Your project photo log`
  const body = `Hi ${customer.name},

Here's the photo log of your project progress:

${link}

— ${fromName || 'Your contractor'}`
  return `mailto:${customer.email ? encodeURIComponent(customer.email) : ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export default function CustomerDetail({ customer, onBack }: Props) {
  const { user } = useUser()
  const [photos, setPhotos] = useState<CustomerPhoto[]>([])
  const [uploading, setUploading] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  // Signed-document folder (estimates / change orders / invoices) for legal protection.
  const [documents, setDocuments] = useState<CustomerDocument[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [docCopiedId, setDocCopiedId] = useState<string | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const fetchPhotos = async () => {
    if (!user?.id) return
    try {
      const snap = await getDocs(query(
        collection(db, 'customerPhotos'),
        where('customerId', '==', customer.id),
        where('createdBy', '==', user.id),
      ))
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as CustomerPhoto))
      list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')) // oldest first for progress log
      setPhotos(list)
    } catch (err) {
      console.error('Photos fetch failed:', err)
    }
  }

  useEffect(() => { fetchPhotos() }, [customer.id, user?.id])

  // Load this customer's signed documents (the legal paper trail).
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    setDocsLoading(true)
    fetchCustomerDocuments(user.id, { id: customer.id, name: customer.name })
      .then(docs => { if (!cancelled) setDocuments(docs) })
      .catch(err => console.error('Customer documents fetch failed:', err))
      .finally(() => { if (!cancelled) setDocsLoading(false) })
    return () => { cancelled = true }
  }, [customer.id, customer.name, user?.id])

  // Open a document's live page (shows the signature; printable from there).
  const openDoc = (d: CustomerDocument) => window.open(d.printUrl || d.publicUrl, '_blank')
  // Copy the document's own public link (each doc type has its own URL path).
  const shareDoc = async (d: CustomerDocument) => {
    try {
      await navigator.clipboard.writeText(d.publicUrl)
      setDocCopiedId(d.id); setTimeout(() => setDocCopiedId(null), 1800)
    } catch {
      // Fallback for browsers without clipboard access — show the link to copy.
      prompt('Copy this link:', d.publicUrl)
    }
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user?.id) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const ts = Date.now()
        const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
        const path = `customerPhotos/${user.id}/${customer.id}/${ts}-${safeName}`
        const sRef = storageRef(storage, path)
        await uploadBytes(sRef, file, { contentType: file.type })
        const photoUrl = await getDownloadURL(sRef)
        const docData: Omit<CustomerPhoto, 'id'> = {
          customerId: customer.id,
          customerName: customer.name,
          caption: '',
          photoUrl,
          storagePath: path,
          createdAt: new Date().toISOString(),
          createdBy: user.id,
        }
        await addDoc(collection(db, 'customerPhotos'), docData)
      }
      await fetchPhotos()
    } catch (err) {
      alert('Upload failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUploading(false)
    }
  }

  const updateCaption = async (id: string, caption: string) => {
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, caption } : p))
    try {
      await updateDoc(doc(db, 'customerPhotos', id), { caption })
    } catch (err) {
      console.error('Caption save failed:', err)
    }
  }

  const deletePhoto = async (p: CustomerPhoto) => {
    if (!confirm('Delete this photo? This cannot be undone.')) return
    try {
      // Best-effort storage delete — even if it fails, remove the Firestore record.
      try { await deleteObject(storageRef(storage, p.storagePath)) } catch {}
      await deleteDoc(doc(db, 'customerPhotos', p.id))
      setPhotos(prev => prev.filter(x => x.id !== p.id))
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleShare = async () => {
    const link = logShareLink(customer.id)
    const fromName = user?.fullName || user?.firstName || undefined
    if (typeof navigator !== 'undefined' && navigator.share) {
      // Use the same nativeShare helper but with a custom title/text/url.
      const ok = await (async () => {
        try {
          await navigator.share({
            title: `Project Photos — ${customer.name}`,
            text: `Hi ${customer.name}, here's the progress log${fromName ? ` from ${fromName}` : ''}:`,
            url: link,
          })
          return true
        } catch { return false }
      })()
      if (ok) return
    }
    const copied = await copyShareLink(customer.id)
    if (copied) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500) }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logShareLink(customer.id))
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    } catch {
      alert(`Copy failed. Manual link: ${logShareLink(customer.id)}`)
    }
  }

  const handlePrint = () => {
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) return
    const rows = photos.map(p => `
      <div class="photo">
        <img src="${p.photoUrl}" alt="${escapeHtml(p.caption || '')}" />
        <div class="caption">
          <strong>${new Date(p.createdAt).toLocaleDateString()}</strong>
          ${p.caption ? ` — ${escapeHtml(p.caption)}` : ''}
        </div>
      </div>`).join('')
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Photo Log — ${escapeHtml(customer.name)}</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1f2e; }
        .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #f97316; padding-bottom: 12px; margin-bottom: 20px; }
        .brand { display: flex; align-items: center; gap: 10px; }
        .brand-mark { width: 36px; height: 36px; background: #f97316; border-radius: 8px; color: white; font-weight: 800; font-size: 20px; display: inline-flex; align-items: center; justify-content: center; }
        .brand-name { font-size: 18px; font-weight: 800; color: #1a1f2e; letter-spacing: -0.5px; }
        .brand-tag { font-size: 10px; color: #64748b; letter-spacing: 1px; text-transform: uppercase; }
        h1 { color: #f97316; font-size: 24px; margin: 0; }
        .photo { page-break-inside: avoid; margin-bottom: 24px; }
        .photo img { width: 100%; max-height: 500px; object-fit: contain; border-radius: 6px; border: 1px solid #e2e8f0; }
        .caption { padding: 8px 0; font-size: 14px; color: #1a1f2e; }
        .meta { color: #64748b; font-size: 13px; line-height: 1.6; margin: 0 0 24px; }
        .footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; text-align: center; }
        @media print { body { padding: 20px; } .photo img { max-height: 90vh; } }
      </style></head><body>
      <div class="header">
        <div class="brand">
          <span class="brand-mark">B</span>
          <div>
            <div class="brand-name">BuildPro<span style="color:#f97316;">+</span></div>
            <div class="brand-tag">Project Photo Log</div>
          </div>
        </div>
        <h1>Photo Log</h1>
      </div>
      <p class="meta"><strong>${escapeHtml(customer.name)}</strong>${customer.address ? ` · ${escapeHtml(customer.address)}` : ''}<br/>Generated ${new Date().toLocaleDateString()} · ${photos.length} photo${photos.length === 1 ? '' : 's'}</p>
      ${photos.length === 0 ? '<p style="color:#94a3b8;">No photos in this log.</p>' : rows}
      <div class="footer">Generated by BuildPro+ · ${escapeHtml(new Date().toLocaleString())}</div>
      <script>setTimeout(() => window.print(), 400)</script>
      </body></html>`)
    w.document.close()
  }

  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const card: React.CSSProperties = { background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <button onClick={onBack} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', marginBottom: '16px' }}>← Back to Customers</button>

      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 700 }}>{customer.name}</h2>
        <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
          {customer.phone}{customer.email && ` · ${customer.email}`}{customer.address && ` · ${customer.address}`}
        </p>
      </div>

      {/* ── Records & Signed Documents — the legal paper trail for this customer.
            Every estimate, change order, and invoice, with the customer's
            e-signature where it applies. View / Print / Share any of them if a
            dispute ever comes up. ── */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>📁 Records &amp; Signed Documents ({documents.length})</h3>
        </div>
        <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 14px' }}>
          Every estimate, change order, and invoice for {customer.name.split(' ')[0]} — with their signature on file. Open to view or print, or copy the link to share. Your protection if anything's ever disputed.
        </p>

        {docsLoading ? (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: '20px 0', fontSize: '14px' }}>Loading records…</p>
        ) : documents.length === 0 ? (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: '20px 0', fontSize: '14px' }}>No documents yet. Estimates, change orders, and invoices for this customer will be filed here automatically.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {documents.map(d => {
              const icon = d.kind === 'estimate' ? '📝' : d.kind === 'change_order' ? '🔄' : '🧾'
              const sigBadge = d.kind === 'invoice'
                ? (d.status === 'paid'
                    ? { text: '✓ Paid', bg: '#f0fdf4', color: '#16a34a' }
                    : { text: d.status === 'overdue' ? 'Overdue' : 'Unpaid', bg: '#fef3c7', color: '#92400e' })
                : (d.signed
                    ? { text: `✍️ Signed by ${d.signedName}${d.signedAction === 'declined' ? ' (declined)' : ''}`, bg: d.signedAction === 'declined' ? '#fef2f2' : '#f0fdf4', color: d.signedAction === 'declined' ? '#dc2626' : '#16a34a' }
                    : { text: 'Not signed yet', bg: '#f1f5f9', color: '#64748b' })
              return (
                <div key={`${d.kind}-${d.id}`} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '22px', flex: '0 0 auto' }}>{icon}</span>
                  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '14px', color: '#1a1f2e' }}>{d.title}</div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>
                      ${d.amount.toLocaleString()} · {d.createdAt ? new Date(d.createdAt).toLocaleDateString() : ''}
                      {d.signedAt && <> · signed {new Date(d.signedAt).toLocaleDateString()}</>}
                    </div>
                    <span style={{ display: 'inline-block', marginTop: '4px', fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', background: sigBadge.bg, color: sigBadge.color }}>{sigBadge.text}</span>
                    {d.retentionLocked && d.lockedUntil && (
                      <div style={{ marginTop: '4px', fontSize: '11px', color: '#7c3aed', fontWeight: 600 }} title="Protected for your legal records — can't be deleted until this date.">🔒 Protected until {d.lockedUntil}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flex: '0 0 auto' }}>
                    <button onClick={() => openDoc(d)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>View / Print</button>
                    <button onClick={() => shareDoc(d)} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>{docCopiedId === d.id ? '✓ Copied' : 'Share'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>📸 Photo Log ({photos.length})</h3>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => cameraRef.current?.click()} disabled={uploading} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
              📷 Take Photo
            </button>
            <button onClick={() => uploadRef.current?.click()} disabled={uploading} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
              Upload Photos
            </button>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => { uploadFiles(e.target.files); e.target.value = '' }} />
            <input ref={uploadRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { uploadFiles(e.target.files); e.target.value = '' }} />
          </div>
        </div>
        {uploading && <p style={{ fontSize: '13px', color: '#7c3aed', margin: '0 0 12px' }}>Uploading…</p>}
        <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>Photos build a timeline of the work. They appear in chronological order — oldest first. Customer sees them all in the shared log.</p>

        {photos.length === 0 ? (
          <p style={{ color: '#94a3b8', textAlign: 'center', padding: '24px 0', fontSize: '14px' }}>No photos yet. Take or upload your first one above.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
            {photos.map(p => (
              <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', background: '#fafafa' }}>
                <img src={p.photoUrl} alt={p.caption} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }} />
                <div style={{ padding: '10px' }}>
                  <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#94a3b8' }}>{new Date(p.createdAt).toLocaleString()}</p>
                  <input
                    placeholder="Add a caption…"
                    value={p.caption}
                    onChange={e => updateCaption(p.id, e.target.value)}
                    style={{ ...input, padding: '6px 8px', fontSize: '13px' }}
                  />
                  <button onClick={() => deletePhoto(p)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', padding: '6px 0 0', fontSize: '12px' }}>
                    🗑️ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...card, border: '2px solid #f97316' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '16px' }}>📤 Share Photo Log with Customer</h3>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#64748b' }}>
          Send the photo log via any channel — works from any device to any device.
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {isPhone() && (
            <button onClick={handleShare} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
              📤 Share
            </button>
          )}
          {isPhone() && (
            <a href={logSmsHref(customer)} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
              💬 Text
            </a>
          )}
          <a href={logMailtoHref(customer, user?.fullName || user?.firstName || undefined)} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
            ✉️ Email
          </a>
          <button onClick={handleCopy} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
            {linkCopied ? '✓ Link copied' : '🔗 Copy link'}
          </button>
          <button onClick={handlePrint} disabled={photos.length === 0} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: photos.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: photos.length === 0 ? 0.5 : 1 }}>
            🖨️ Print / PDF
          </button>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#94a3b8' }}>
          Print opens the browser print dialog — choose "Save as PDF" from the destination dropdown to get a PDF file.
        </p>
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
