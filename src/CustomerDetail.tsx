import { useState, useEffect, useRef } from 'react'
import { db, storage } from './firebase'
import { collection, addDoc, getDocs, query, where, doc, deleteDoc, updateDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useUser } from '@clerk/clerk-react'
import { copyShareLink, isPhone } from './lib/shareEstimate'
import type { CustomerPhoto } from './data/types'

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
// Pinned to .web.app to avoid the false-positive Safe Browsing flag on the
// shared .firebaseapp.com domain.
const PUBLIC_HOST = 'https://contractors-office-96731.web.app'
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
  const card: React.CSSProperties = { background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <button onClick={onBack} style={{ background: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', marginBottom: '16px' }}>← Back to Customers</button>

      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 700 }}>{customer.name}</h2>
        <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
          {customer.phone}{customer.email && ` · ${customer.email}`}{customer.address && ` · ${customer.address}`}
        </p>
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
