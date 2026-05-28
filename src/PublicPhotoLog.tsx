import { useEffect, useState } from 'react'
import { collection, getDocs, query, where, doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { CustomerPhoto } from './data/types'
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
  const [photos, setPhotos] = useState<CustomerPhoto[]>([])
  const [businessName, setBusinessName] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const cSnap = await getDoc(doc(db, 'customers', customerId))
        let ownerId: string | undefined
        if (cSnap.exists()) {
          const cd = cSnap.data() as { name?: string; address?: string; createdBy?: string }
          setCustomer({ id: cSnap.id, name: cd.name || 'Customer', address: cd.address })
          ownerId = cd.createdBy
        }
        const pSnap = await getDocs(query(
          collection(db, 'customerPhotos'),
          where('customerId', '==', customerId),
        ))
        const list = pSnap.docs.map(d => ({ id: d.id, ...d.data() } as CustomerPhoto))
        list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
        setPhotos(list)
        if (ownerId) {
          try {
            const userSnap = await getDoc(doc(db, 'users', ownerId))
            if (userSnap.exists()) {
              const u = userSnap.data() as { businessName?: string; businessPhone?: string; businessEmail?: string; licenseNumber?: string; logoUrl?: string }
              if (u.businessName?.trim()) setBusinessName(u.businessName.trim())
              if (u.businessPhone?.trim()) setBusinessPhone(u.businessPhone.trim())
              if (u.businessEmail?.trim()) setBusinessEmail(u.businessEmail.trim())
              if (u.licenseNumber?.trim()) setLicenseNumber(u.licenseNumber.trim())
              if (u.logoUrl?.trim()) setLogoUrl(u.logoUrl.trim())
            }
          } catch { /* graceful fallback */ }
        }
      } catch {
        setError('Could not load the photo log. Please contact your contractor.')
      } finally {
        setLoading(false)
      }
    })()
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
      <div style={{ maxWidth: '780px', margin: '0 auto', background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
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
            <p style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 0' }}>No photos in this log yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {photos.map(p => (
                <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', background: '#fafafa' }}>
                  <img src={p.photoUrl} alt={p.caption} style={{ width: '100%', maxHeight: '600px', objectFit: 'contain', display: 'block', background: '#1a1f2e' }} />
                  <div style={{ padding: '12px 16px' }}>
                    <p style={{ margin: '0 0 4px', fontSize: '12px', color: '#94a3b8' }}>{new Date(p.createdAt).toLocaleString()}</p>
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
