import { useEffect, useMemo, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { collection, query, where, onSnapshot, doc, deleteDoc, addDoc } from 'firebase/firestore'
import { db } from './firebase'
import EstimatePreview from './EstimatePreview'
import { openEstimatePrintWindow } from './lib/printEstimate'
import { copyShareLink, shareLinkFor } from './lib/shareEstimate'
import { fetchBusinessProfile } from './Settings'
import type { BusinessProfile } from './Settings'
import type { Estimate } from './data/types'

const ORANGE = '#f97316'

type Tab = 'pending' | 'approved' | 'declined'

// Dedicated estimates dashboard, grouped by customer decision:
//  • Pending  — sent, awaiting the customer's approve/decline.
//  • Approved — customer signed; flows on to the job/project.
//  • Declined — customer said no (with their reason); user can keep & redo, or delete.
export default function Estimates({ initialTab = 'pending' }: { initialTab?: Tab }) {
  const { user } = useUser()
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [tab, setTab] = useState<Tab>(initialTab)
  const [preview, setPreview] = useState<Estimate | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [profile, setProfile] = useState<BusinessProfile>({ businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '' })

  useEffect(() => {
    if (!user?.id) return
    const unsub = onSnapshot(
      query(collection(db, 'estimates'), where('createdBy', '==', user.id)),
      snap => setEstimates(snap.docs.map(d => ({ id: d.id, ...d.data() } as Estimate))),
      err => console.error('Estimates listener failed:', err),
    )
    return () => unsub()
  }, [user?.id])

  useEffect(() => {
    if (user?.id) fetchBusinessProfile(user.id).then(setProfile).catch(() => {})
  }, [user?.id])

  const buckets = useMemo(() => {
    const sortDesc = (a: Estimate, b: Estimate) => (b.createdAt || '').localeCompare(a.createdAt || '')
    return {
      pending: estimates.filter(e => e.status === 'pending').sort(sortDesc),
      approved: estimates.filter(e => e.status === 'approved').sort(sortDesc),
      declined: estimates.filter(e => e.status === 'declined').sort(sortDesc),
    }
  }, [estimates])

  const deleteEstimate = async (e: Estimate) => {
    // Stronger warning when deleting an APPROVED estimate — it's tied to an
    // in-flight project. The project itself stays, but the customer-facing link
    // and signed copy go away.
    const isApproved = e.status === 'approved'
    const msg = isApproved
      ? `⚠ Heads up — this estimate is APPROVED ($${(e.total || 0).toFixed(2)} for ${e.customerName}). Deleting it removes the customer's share link and the signed copy, but the linked project stays. Are you sure?`
      : `Delete the estimate for "${e.customerName}" ($${(e.total || 0).toFixed(2)})? This cannot be undone.`
    if (!confirm(msg)) return
    try {
      await deleteDoc(doc(db, 'estimates', e.id))
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // Clone an estimate as a fresh, pending one — "same as the last bathroom".
  // New ID, status reset to pending, no customer response, not yet linked to a
  // project (the sweep will create a fresh project when it's approved/sent).
  const duplicateEstimate = async (e: Estimate) => {
    if (!user?.id) { alert('Not signed in.'); return }
    try {
      const { id: _omit, customerResponse: _r, projectAutoCreated: _pac, projectId: _pid, ...rest } = e as Estimate & Record<string, unknown>
      void _omit; void _r; void _pac; void _pid
      const clone: Record<string, unknown> = {
        ...rest,
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdBy: user.id,
      }
      const ref = await addDoc(collection(db, 'estimates'), clone)
      // Open the new copy in the editor so they can tweak customer/details.
      setPreview({ id: ref.id, ...clone } as Estimate)
    } catch (err) {
      alert('Could not duplicate: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const shareEstimate = async (e: Estimate) => {
    // Try native share on phones; otherwise fall back to copying the link.
    const link = shareLinkFor(e.id)
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title: `Estimate — ${e.customerName}`, text: `Your estimate: ${link}`, url: link })
        return
      } catch { /* user cancelled, fall through to copy */ }
    }
    const ok = await copyShareLink(e.id)
    if (ok) {
      setCopiedId(e.id)
      setTimeout(() => setCopiedId(prev => prev === e.id ? null : prev), 2500)
    } else {
      alert(`Copy failed. Manual link: ${link}`)
    }
  }

  const card: React.CSSProperties = { background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', padding: '16px', marginBottom: '12px' }
  const list = buckets[tab]

  const tabBtn = (key: Tab, label: string, count: number, color: string) => (
    <button onClick={() => setTab(key)} style={{ padding: '8px 16px', border: tab === key ? `2px solid ${color}` : '1px solid #e2e8f0', background: tab === key ? '#fff7ed' : 'white', borderRadius: '999px', cursor: 'pointer', fontWeight: 700, fontSize: '13px', color: tab === key ? color : '#64748b' }}>
      {label} ({count})
    </button>
  )

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '900px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '24px', fontWeight: 800, margin: '0 0 4px', color: '#1a1f2e' }}>📝 Estimates</h2>
      <p style={{ margin: '0 0 16px', color: '#64748b', fontSize: '14px' }}>Track what's awaiting a customer's decision, what they approved, and what they declined.</p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
        {tabBtn('pending', '⏳ Pending', buckets.pending.length, '#ea580c')}
        {tabBtn('approved', '✅ Approved', buckets.approved.length, '#16a34a')}
        {tabBtn('declined', '❌ Declined', buckets.declined.length, '#dc2626')}
      </div>

      {list.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: '#94a3b8', padding: '40px 16px' }}>
          {tab === 'pending' && 'No estimates are awaiting a customer decision right now. Make one in Quick Quote and send it.'}
          {tab === 'approved' && 'No approved estimates yet. When a customer accepts, it shows here and moves to your Projects.'}
          {tab === 'declined' && 'No declined estimates. If a customer declines, it lands here with their reason so you can adjust and resend.'}
        </div>
      ) : (
        list.map(e => {
          const resp = e.customerResponse
          return (
            <div key={e.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: '16px' }}>{e.customerName}</p>
                  <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#64748b' }}>
                    {e.jobTypeName} · <strong style={{ color: ORANGE }}>${(e.total || 0).toFixed(2)}</strong> · {new Date(e.createdAt).toLocaleDateString()}
                  </p>
                  {tab === 'pending' && (
                    <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#ea580c', fontWeight: 600 }}>⏳ Sent — awaiting the customer's decision.</p>
                  )}
                  {tab === 'approved' && resp && (
                    <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#16a34a', fontWeight: 600 }}>
                      ✅ Approved by {resp.signedName} on {new Date(resp.respondedAt).toLocaleDateString()} — now in Projects.
                    </p>
                  )}
                  {tab === 'declined' && resp && (
                    <div style={{ margin: '8px 0 0', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '8px 12px' }}>
                      <p style={{ margin: 0, fontSize: '12px', color: '#dc2626', fontWeight: 700 }}>
                        ❌ Declined by {resp.signedName} on {new Date(resp.respondedAt).toLocaleDateString()}
                      </p>
                      {resp.reason
                        ? <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#1a1f2e', fontStyle: 'italic' }}>"{resp.reason}"</p>
                        : <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#94a3b8' }}>No reason given.</p>}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button onClick={() => setPreview(e)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {tab === 'declined' ? '✏️ Adjust & Resend' : '✏️ Edit'}
                  </button>
                  <button onClick={() => shareEstimate(e)} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    {copiedId === e.id ? '✓ Copied' : '📤 Share'}
                  </button>
                  <button onClick={() => duplicateEstimate(e)} title="Make a copy to reuse for a similar job" style={{ background: 'white', color: '#1a1f2e', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    📄 Duplicate
                  </button>
                  <button onClick={() => deleteEstimate(e)} style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                    🗑️ Delete
                  </button>
                </div>
              </div>
              {tab === 'declined' && (
                <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#64748b' }}>
                  💡 Tip: open it, adjust the price or scope to better fit what the customer wanted, then re-send — they may approve the improved version. Or delete it if you're moving on.
                </p>
              )}
            </div>
          )
        })
      )}

      {preview && (
        <EstimatePreview
          estimate={preview}
          onClose={() => setPreview(null)}
          onSaved={(updated) => setPreview(updated)}
          onPrint={(est) => openEstimatePrintWindow(est, profile)}
        />
      )}
    </div>
  )
}
