// Branded header used on customer-facing public pages (estimate / change order
// / photo log / thank-you). Keeps the look consistent and reinforces the
// contractor's brand (or BuildPro+ default) for customers.

interface Props {
  title: string
  subtitle?: string
  // When set, replaces the BuildPro+ wordmark with the contractor's brand.
  businessName?: string
  // When set, replaces the orange "B" square with the contractor's logo image.
  logoUrl?: string
  // Optional contact info — shown in a small caption row below the brand.
  businessPhone?: string
  businessEmail?: string
  licenseNumber?: string
}

export function BrandHeader({ title, subtitle, businessName, logoUrl, businessPhone, businessEmail, licenseNumber }: Props) {
  const hasBusiness = !!businessName?.trim()
  const initial = (businessName?.trim()[0] || 'B').toUpperCase()
  const contactBits = [businessPhone?.trim(), businessEmail?.trim(), licenseNumber?.trim() ? `Lic. ${licenseNumber.trim()}` : ''].filter(Boolean)

  return (
    <div style={{ background: 'linear-gradient(135deg, #1a1f2e 0%, #0f172a 100%)', color: 'white', padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        {/* Logo square: contractor logo if uploaded, otherwise initial letter on orange */}
        <div style={{ width: '40px', height: '40px', background: logoUrl ? 'white' : '#f97316', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {logoUrl
            ? <img src={logoUrl} alt={businessName || 'logo'} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ color: 'white', fontWeight: 800, fontSize: '20px' }}>{initial}</span>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {hasBusiness ? (
            <>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'white', letterSpacing: '-0.5px', lineHeight: 1.1 }}>{businessName}</div>
              <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '2px' }}>
                Powered by BuildPro<span style={{ color: '#f97316' }}>+</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'white', letterSpacing: '-0.5px', lineHeight: 1.1 }}>BuildPro<span style={{ color: '#f97316' }}>+</span></div>
              <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '2px' }}>Contractor Suite</div>
            </>
          )}
        </div>
      </div>
      {contactBits.length > 0 && (
        <p style={{ margin: '0 0 12px', color: '#cbd5e1', fontSize: '12px', lineHeight: 1.4 }}>
          {contactBits.join(' · ')}
        </p>
      )}
      <h1 style={{ margin: '0 0 4px', color: '#f97316', fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px' }}>{title}</h1>
      {subtitle && <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px' }}>{subtitle}</p>}
    </div>
  )
}

export function BrandFooter() {
  return (
    <p style={{ fontSize: '11px', color: '#94a3b8', margin: '24px 0 0', textAlign: 'center', letterSpacing: '0.5px' }}>
      Powered by <strong style={{ color: '#1a1f2e' }}>BuildPro<span style={{ color: '#f97316' }}>+</span></strong>
    </p>
  )
}
