import { useState, useRef } from 'react'
import { useUser } from '@clerk/clerk-react'
import { doc, setDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

// One-time required onboarding shown right after a new contractor's first
// sign-in (until they've set a business name). The business name + contact info
// + logo flow into every customer-facing & AI-generated output: estimates,
// invoices, change orders, thank-you letters, and printed/shared documents.
export default function BusinessOnboarding({ onDone }: { onDone: () => void }) {
  const { user } = useUser()
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState(user?.primaryEmailAddress?.emailAddress || '')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoStoragePath, setLogoStoragePath] = useState('')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const logoRef = useRef<HTMLInputElement>(null)

  const uploadLogo = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user?.id) return
    const file = files[0]
    setUploadingLogo(true)
    setError('')
    try {
      const ts = Date.now()
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
      const path = `userLogos/${user.id}/${ts}-${safeName}`
      const sRef = storageRef(storage, path)
      await uploadBytes(sRef, file, { contentType: file.type })
      const url = await getDownloadURL(sRef)
      setLogoUrl(url)
      setLogoStoragePath(path)
    } catch (err) {
      setError('Logo upload failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUploadingLogo(false)
    }
  }

  const save = async () => {
    if (!user?.id) { setError('Not signed in.'); return }
    if (!businessName.trim()) { setError('Please enter your business name to continue.'); return }
    setSaving(true)
    setError('')
    try {
      await setDoc(doc(db, 'users', user.id), {
        businessName: businessName.trim(),
        businessPhone: businessPhone.trim(),
        businessEmail: businessEmail.trim(),
        licenseNumber: licenseNumber.trim(),
        logoUrl: logoUrl || '',
        logoStoragePath: logoStoragePath || '',
        onboardedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true })
      onDone()
    } catch (err) {
      setError('Could not save: ' + (err instanceof Error ? err.message : String(err)))
      setSaving(false)
    }
  }

  const input: React.CSSProperties = { width: '100%', padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '15px', boxSizing: 'border-box' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }

  return (
    <div style={{ minHeight: '100vh', background: `linear-gradient(135deg, ${NAVY} 0%, #0f172a 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ background: 'white', borderRadius: '16px', maxWidth: '520px', width: '100%', padding: '32px', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ width: '56px', height: '56px', background: ORANGE, borderRadius: '14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', fontWeight: 800, color: 'white', marginBottom: '12px' }}>B</div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: '0 0 6px', color: NAVY }}>Welcome to BuildPro+</h1>
          <p style={{ margin: 0, color: '#64748b', fontSize: '14px', lineHeight: 1.5 }}>
            Let's set up your business. This appears on every estimate, invoice, and letter your customers see.
          </p>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={label}>Business Name *</label>
          <input value={businessName} onChange={e => setBusinessName(e.target.value)} style={input} placeholder="e.g. Bowling Construction LLC" autoFocus />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
          <div>
            <label style={label}>Phone</label>
            <input value={businessPhone} onChange={e => setBusinessPhone(e.target.value)} style={input} placeholder="(336) 555-0142" />
          </div>
          <div>
            <label style={label}>Email</label>
            <input value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} style={input} placeholder="you@business.com" />
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={label}>License # (optional)</label>
          <input value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} style={input} placeholder="NC GC #12345" />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={label}>Logo (optional)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {logoUrl
              ? <img src={logoUrl} alt="logo" style={{ width: '48px', height: '48px', objectFit: 'contain', borderRadius: '8px', border: '1px solid #e2e8f0' }} />
              : <div style={{ width: '48px', height: '48px', borderRadius: '8px', background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '20px' }}>🏢</div>}
            <button onClick={() => logoRef.current?.click()} disabled={uploadingLogo} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 16px', borderRadius: '8px', cursor: uploadingLogo ? 'default' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
              {uploadingLogo ? 'Uploading…' : logoUrl ? 'Change logo' : 'Upload logo'}
            </button>
            <input ref={logoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { uploadLogo(e.target.files); e.target.value = '' }} />
          </div>
        </div>

        {error && <p style={{ color: '#dc2626', fontSize: '13px', margin: '0 0 12px' }}>⚠ {error}</p>}

        <button onClick={save} disabled={saving} style={{ width: '100%', background: saving ? '#cbd5e1' : ORANGE, color: 'white', border: 'none', padding: '14px', borderRadius: '10px', cursor: saving ? 'default' : 'pointer', fontWeight: 700, fontSize: '16px', boxShadow: '0 4px 12px rgba(249,115,22,0.3)' }}>
          {saving ? 'Setting up…' : 'Start Using BuildPro+ →'}
        </button>
        <p style={{ textAlign: 'center', margin: '12px 0 0', fontSize: '12px', color: '#94a3b8' }}>You can change any of this later in Settings.</p>
      </div>
    </div>
  )
}
