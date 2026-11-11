import { useEffect, useState } from 'react'

// A plain bar that appears while the phone has no connection. Saving needs a
// connection in this app, so on a job site with no signal the contractor
// should know that BEFORE typing in an estimate, not after tapping Save.
export default function OfflineNotice() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  if (online) return null
  return (
    <div role="status" aria-live="polite" style={{ position: 'sticky', top: 0, zIndex: 400, background: '#7c2d12', color: 'white', padding: '10px 16px', fontSize: '14px', fontWeight: 600, textAlign: 'center' }}>
      No connection. You can keep reading, but wait for signal before saving or sending.
    </div>
  )
}
