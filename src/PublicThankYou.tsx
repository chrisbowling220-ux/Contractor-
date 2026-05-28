import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { ThankYouPackage } from './data/types'

// Public thank-you page at /thanks/<id>. No sign-in required.
// Renders the AI-written letter + slideshow of project photos.
export default function PublicThankYou({ packageId }: { packageId: string }) {
  const [pkg, setPkg] = useState<ThankYouPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'thankYouPackages', packageId))
        if (!snap.exists()) setError('This page could not be found.')
        else setPkg({ id: snap.id, ...snap.data() } as ThankYouPackage)
      } catch {
        setError('Could not load. Please contact your contractor.')
      } finally { setLoading(false) }
    })()
  }, [packageId])

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}><p style={{ color: '#64748b' }}>Loading…</p></div>
  }
  if (error || !pkg) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
        <div style={{ maxWidth: '460px', textAlign: 'center' }}>
          <h1 style={{ color: '#dc2626', fontSize: '20px', marginBottom: '12px' }}>Not Available</h1>
          <p style={{ color: '#64748b' }}>{error || 'Unknown error.'}</p>
        </div>
      </div>
    )
  }

  const { letter, photos } = pkg
  const today = pkg.createdAt ? new Date(pkg.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 'clamp(16px, 4vw, 32px) clamp(12px, 3vw, 24px)' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>

        {/* Letter — branded as a real letterhead */}
        <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: 'clamp(24px, 5vw, 48px)', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '3px solid #f97316', paddingBottom: '12px', marginBottom: '28px', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '40px', height: '40px', background: '#f97316', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '22px' }}>
                {pkg.contractorBusiness?.trim()?.[0]?.toUpperCase() || 'B'}
              </div>
              <div>
                {pkg.contractorBusiness?.trim() ? (
                  <>
                    <div style={{ fontSize: '17px', fontWeight: 800, color: '#1a1f2e', letterSpacing: '-0.5px' }}>{pkg.contractorBusiness}</div>
                    <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '1px', textTransform: 'uppercase' }}>Powered by BuildPro<span style={{ color: '#f97316' }}>+</span></div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '17px', fontWeight: 800, color: '#1a1f2e', letterSpacing: '-0.5px' }}>BuildPro<span style={{ color: '#f97316' }}>+</span></div>
                    <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '1px', textTransform: 'uppercase' }}>Contractor Suite</div>
                  </>
                )}
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

        {/* Slideshow intro */}
        {photos.length > 0 && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: 'clamp(32px, 6vw, 56px)', marginBottom: '20px', textAlign: 'center' }}>
            <h2 style={{ fontSize: 'clamp(24px, 5vw, 32px)', color: '#1a1f2e', margin: '0 0 12px', letterSpacing: '-0.5px' }}>A look at <span style={{ color: '#f97316' }}>your project</span></h2>
            <p style={{ color: '#64748b', fontSize: '15px', maxWidth: '500px', margin: '0 auto', lineHeight: 1.6 }}>A few photos from start to finish. We're proud of how it came together — and grateful you trusted us with the work.</p>
            <div style={{ marginTop: '24px', fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '2px' }}>{photos.length} photo{photos.length === 1 ? '' : 's'} · in order</div>
          </div>
        )}

        {/* Photo gallery */}
        {photos.map((p, i) => (
          <div key={i} style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: '20px', marginBottom: '16px' }}>
            <img src={p.photoUrl} alt={p.caption || `Photo ${i + 1}`} style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '6px', background: '#000', display: 'block' }} />
            {p.caption && <p style={{ margin: '14px 0 4px', fontSize: '15px', color: '#1a1f2e', fontStyle: 'italic', textAlign: 'center' }}>{p.caption}</p>}
            <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#94a3b8', textAlign: 'center' }}>Photo {i + 1} of {photos.length}{p.createdAt ? ` · ${new Date(p.createdAt).toLocaleDateString()}` : ''}</p>
          </div>
        ))}

        {/* Save / Print buttons */}
        <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: '20px', marginBottom: '20px', textAlign: 'center' }}>
          <button onClick={() => window.print()} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
            🖨️ Print or Save as PDF
          </button>
          <p style={{ margin: '12px 0 0', fontSize: '12px', color: '#94a3b8' }}>Want a hard copy? Use the print dialog and choose "Save as PDF" for a digital file.</p>
        </div>

        <p style={{ fontSize: '11px', color: '#94a3b8', textAlign: 'center', margin: '24px 0' }}>
          Powered by <strong style={{ color: '#1a1f2e' }}>BuildPro<span style={{ color: '#f97316' }}>+</span></strong>
        </p>
      </div>

      {/* Print styles: clean letterhead look */}
      <style>{`
        @media print {
          body { background: white; }
          button { display: none !important; }
        }
      `}</style>
    </div>
  )
}
