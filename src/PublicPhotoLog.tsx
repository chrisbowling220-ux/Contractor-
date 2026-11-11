import { useEffect, useState } from 'react'
import { fetchPhotoLog, fetchPublicProfile } from './lib/publishCopies'
import type { PhotoLogEntry } from './lib/publicCopies'
import { BrandHeader, BrandFooter } from './lib/BrandHeader'

interface Customer {
  id: string
  name: string
  address?: string
}

// Public photo-log view at /log/<customerId>. No sign-in required.
// Renders all photos in chronological order with captions.
export default function PublicPhotoLog({ customerId }: { customerId: string }) {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [photos, setPhotos] = useState<PhotoLogEntry[]>([])
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let done = false
    const fallbackTimer = window.setTimeout(() => {
      if (done) return
      setError('Taking longer than expected. Check your connection and reload, or ask your contractor to resend.')
      setLoading(false)
    }, 15000)
    ;(async () => {
      try {
        // The contractor's app publishes a customer-safe copy of the log
        // (name, address, photos). This page never reads the customer record.
        const log = await fetchPhotoLog(customerId)
        if (done) return
        if (!log) {
          setError('This photo log is not available. Please ask your contractor to send the link again.')
          return
        }
        setCustomer({ id: customerId, name: log.customerName, address: log.address || undefined })
        setPhotos(log.photos)
        const u = await fetchPublicProfile(log.createdBy)
        if (done) return
        if (u.businessName) setBusinessName(u.businessName)
        if (u.businessPhone) setBusinessPhone(u.businessPhone)
        if (u.businessEmail) setBusinessEmail(u.businessEmail)
        if (u.licenseNumber) setLicenseNumber(u.licenseNumber)
        if (u.logoUrl) setLogoUrl(u.logoUrl)
      } catch (err) {
        if (done) return
        console.error('PublicPhotoLog load failed:', err)
        setError('Could not load the photo log. Please reload the page or contact your contractor.')
      } finally {
        done = true
        window.clearTimeout(fallbackTimer)
        setLoading(false)
      }
    })()
    return () => { done = true; window.clearTimeout(fallbackTimer) }
  }, [customerId])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}>
        <p style={{ color: '#64748b' }}>Loading photo log…</p>
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
        <div style={{ maxWidth: '460px', textAlign: 'center' }}>
          <h1 style={{ color: '#dc2626', fontSize: '20px', marginBottom: '12px' }}>Log Unavailable</h1>
          <p style={{ color: '#64748b' }}>{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ maxWidth: '780px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', overflow: 'hidden' }}>
        <BrandHeader
          title="📸 Project Photo Log"
          subtitle={`${customer?.name || 'Customer'}${customer?.address ? ` · ${customer.address}` : ''} · ${photos.length} photo${photos.length === 1 ? '' : 's'}`}
          businessName={businessName}
          logoUrl={logoUrl}
          businessPhone={businessPhone}
          businessEmail={businessEmail}
          licenseNumber={licenseNumber}
        />

        <div style={{ padding: '20px' }}>
          {photos.length === 0 ? (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '40px 0' }}>No photos in this log yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {photos.map(p => (
                <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', background: '#fafafa' }}>
                  <img src={p.photoUrl} alt={p.caption} style={{ width: '100%', maxHeight: '600px', objectFit: 'contain', display: 'block', background: '#1a1f2e' }} />
                  <div style={{ padding: '12px 16px' }}>
                    <p style={{ margin: '0 0 4px', fontSize: '12px', color: '#64748b' }}>{new Date(p.createdAt).toLocaleString()}</p>
                    {p.caption && <p style={{ margin: 0, fontSize: '14px', color: '#1a1f2e' }}>{p.caption}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: '13px', color: '#64748b', margin: '20px 0 0', textAlign: 'center' }}>
            Questions? Reply to the message your contractor sent you.
          </p>
        </div>
      </div>
      <BrandFooter />
    </div>
  )
}
