import { useState } from 'react'
import type { ProposalLetter } from './data/types'

interface Props {
  proposal: ProposalLetter
  busy: boolean
  onSave: (p: ProposalLetter, edited: boolean) => Promise<void> | void
  onRegenerate: () => Promise<void> | void
  onClose: () => void
}

// In-app editor for the customer-facing proposal letter. The contractor can
// tweak any section, regenerate a fresh one, then save. Opens as a modal (no
// popup window) so closing returns to the estimate editor.
export default function ProposalEditor({ proposal, busy, onSave, onRegenerate, onClose }: Props) {
  const [draft, setDraft] = useState<ProposalLetter>(proposal)
  const [saving, setSaving] = useState(false)

  // Keep the draft in sync if a regenerate replaces the proposal underneath us.
  const [lastProp, setLastProp] = useState(proposal)
  if (proposal !== lastProp) {
    setLastProp(proposal)
    setDraft(proposal)
  }

  const set = (k: keyof ProposalLetter, v: string) => setDraft(d => ({ ...d, [k]: v }))

  const doSave = async () => {
    setSaving(true)
    try {
      // Saving from here means the contractor reviewed/edited it.
      await onSave(draft, true)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const field = (labelText: string, k: keyof ProposalLetter, rows: number, hint?: string) => (
    <div style={{ marginBottom: '14px' }}>
      <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
        {labelText}
      </label>
      {hint && <p style={{ margin: '0 0 4px', fontSize: '11px', color: '#94a3b8' }}>{hint}</p>}
      <textarea
        value={draft[k]}
        onChange={e => set(k, e.target.value)}
        rows={rows}
        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }}
      />
    </div>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '720px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>📄 Proposal Letter</h2>
            <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#cbd5e1' }}>The professional cover the customer sees first — above the estimate.</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'rgba(255,255,255,0.12)', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap' }}>
            ✕ Close
          </button>
        </div>

        <div style={{ padding: '16px 18px', maxHeight: '64vh', overflowY: 'auto' }}>
          {busy ? (
            <p style={{ color: '#64748b', fontSize: '14px', padding: '20px 0' }}>Writing your proposal…</p>
          ) : (
            <>
              {field('Greeting', 'greeting', 1)}
              {field('Introduction', 'intro', 3)}
              {field('Our Approach', 'approach', 4, 'How the job will be performed and handled.')}
              {field('What’s Included', 'included', 4, 'One item per line.')}
              {field('Not Included', 'not_included', 4, 'Sets clear expectations — one item per line.')}
              {field('Timeline', 'timeline', 2)}
              {field('Workmanship Guarantee', 'warranty', 2)}
              {field('Closing & Signature', 'closing', 4)}
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid #e2e8f0', padding: '14px 18px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <button onClick={doSave} disabled={busy || saving} style={{ background: '#f97316', color: 'white', border: 'none', borderRadius: '8px', padding: '12px 20px', cursor: (busy || saving) ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: '14px' }}>
            {saving ? 'Saving…' : '💾 Save Proposal'}
          </button>
          <button onClick={onRegenerate} disabled={busy || saving} style={{ background: 'transparent', color: '#7c3aed', border: '1px solid #7c3aed', borderRadius: '8px', padding: '12px 16px', cursor: (busy || saving) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '13px' }}>
            🔄 Rewrite for me
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: '#f1f5f9', color: '#1a1f2e', border: 'none', borderRadius: '8px', padding: '12px 18px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
