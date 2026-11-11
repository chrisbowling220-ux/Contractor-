import { useEffect, useState } from 'react'
import { cancelAccountDeletion, requestAccountDeletion, watchDeletionRequest, type DeletionRequest } from './lib/accountDeletion'

// Settings → "Delete my account". Records a request; see lib/accountDeletion.ts.
export default function DeleteAccountCard({ userId, isPro }: { userId: string; isPro: boolean }) {
  const [request, setRequest] = useState<DeletionRequest | null>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => watchDeletionRequest(userId, setRequest), [userId])

  const submit = async () => {
    setBusy(true); setError('')
    try {
      await requestAccountDeletion(userId, note)
      setOpen(false); setNote(''); setConfirmText('')
    } catch (err) {
      setError('Could not send the request. Check your connection and try again. ' + (err instanceof Error ? err.message : ''))
    } finally { setBusy(false) }
  }
  const cancel = async () => {
    setBusy(true); setError('')
    try { await cancelAccountDeletion(userId) }
    catch (err) { setError('Could not cancel the request. ' + (err instanceof Error ? err.message : '')) }
    finally { setBusy(false) }
  }

  const card: React.CSSProperties = { background: 'white', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)', padding: '20px', marginBottom: '16px' }
  const small: React.CSSProperties = { margin: '0 0 12px', fontSize: '13px', color: '#475569', lineHeight: 1.5 }

  return (
    <section style={card} aria-labelledby="delete-account-heading">
      <h3 id="delete-account-heading" style={{ margin: '0 0 4px', fontSize: '16px' }}>🗑️ Delete my account</h3>

      {request ? (
        <>
          <p role="status" style={{ ...small, color: '#b91c1c', fontWeight: 600 }}>
            Deletion requested on {new Date(request.requestedAt).toLocaleDateString()}. We'll delete your account and data within 30 days and email you when it's done.
          </p>
          <p style={small}>Changed your mind? You can cancel the request any time before then.</p>
          <button onClick={cancel} disabled={busy} style={{ background: 'white', color: '#1a1f2e', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
            {busy ? 'Cancelling…' : 'Keep my account'}
          </button>
        </>
      ) : !open ? (
        <>
          <p style={small}>Ask us to permanently delete your account and everything in it.</p>
          <button onClick={() => setOpen(true)} style={{ background: 'white', color: '#b91c1c', border: '1px solid #fecaca', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
            Delete my account…
          </button>
        </>
      ) : (
        <>
          <p style={small}>
            This removes your business profile, customers, estimates, invoices, projects, photos and schedule. It cannot be undone.
          </p>
          <ul style={{ ...small, paddingLeft: '20px' }}>
            <li>Customer-signed documents and paid invoices are kept for up to two years after signing or payment, as your Terms describe, and are then deleted.</li>
            <li>Links you've sent to customers will stop working.</li>
            {isPro && <li><strong>You have an active Pro subscription.</strong> Cancel it first under Subscription above so you aren't billed again.</li>}
          </ul>
          <label htmlFor="delete-note" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>Anything we should know? (optional)</label>
          <textarea id="delete-note" value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={1000}
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '14px', fontFamily: 'inherit', marginBottom: '12px' }} />
          <label htmlFor="delete-confirm" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>Type DELETE to confirm</label>
          <input id="delete-confirm" value={confirmText} onChange={e => setConfirmText(e.target.value)} autoComplete="off"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '14px', marginBottom: '12px' }} />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={submit} disabled={busy || confirmText.trim().toUpperCase() !== 'DELETE'}
              style={{ background: confirmText.trim().toUpperCase() === 'DELETE' ? '#b91c1c' : '#e2e8f0', color: confirmText.trim().toUpperCase() === 'DELETE' ? 'white' : '#475569', border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
              {busy ? 'Sending…' : 'Request deletion'}
            </button>
            <button onClick={() => { setOpen(false); setConfirmText(''); setError('') }} style={{ background: 'white', color: '#1a1f2e', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '14px' }}>
              Never mind
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" style={{ margin: '12px 0 0', fontSize: '13px', color: '#b91c1c' }}>{error}</p>}
    </section>
  )
}
