import { useState } from 'react'
import type { Estimate } from './data/types'
import {
  materialRowsFromEstimate,
  hasMaterialsList,
  openMaterialsListPrintWindow,
  shareMaterialsList,
} from './lib/materialsList'

interface Props {
  estimate: Estimate
  businessName?: string
  onClose: () => void
}

// In-app Materials List viewer. Renders the contractor's shopping checklist
// ON-SCREEN inside a modal (NOT a popup window) so closing it returns to the
// estimate — no separate tab, no app-exit, no dead-end. Print and Share are
// available right here; Print is the only thing that opens an OS print sheet,
// which returns on its own.
export default function MaterialsListModal({ estimate, businessName, onClose }: Props) {
  const rows = materialRowsFromEstimate(estimate)
  const [shareMsg, setShareMsg] = useState('')

  const doShare = async () => {
    const result = await shareMaterialsList(estimate, businessName)
    if (result === 'shared') setShareMsg('')
    else if (result === 'copied') setShareMsg('✓ Copied to clipboard — paste it anywhere')
    else setShareMsg('Couldn’t share — try Print instead')
    if (result === 'copied') setTimeout(() => setShareMsg(''), 3000)
  }

  const btn: React.CSSProperties = {
    border: 'none', borderRadius: '8px', padding: '12px 18px', cursor: 'pointer',
    fontWeight: 700, fontSize: '14px',
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '640px', margin: '24px auto', background: 'white', borderRadius: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header with a clear way back */}
        <div style={{ background: '#1a1f2e', color: 'white', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>🛒 Materials List</h2>
            <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#cbd5e1' }}>
              {estimate.customerName}{estimate.jobTypeName ? ` — ${estimate.jobTypeName}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close materials list"
            style={{ background: 'rgba(255,255,255,0.12)', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap' }}
          >
            ✕ Close
          </button>
        </div>

        {/* On-screen checklist (no prices — this is the shopping list) */}
        <div style={{ padding: '16px 18px', overflowY: 'auto', maxHeight: '60vh' }}>
          {hasMaterialsList(estimate) ? (
            <>
              <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#64748b' }}>
                Quantities include waste. Check items off as you gather them.
              </p>
              <div>
                {rows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <span style={{ width: '18px', height: '18px', border: '2px solid #94a3b8', borderRadius: '4px', flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '15px', color: '#1a1f2e' }}>{r.name}</span>
                    <span style={{ fontWeight: 700, color: '#1a1f2e', whiteSpace: 'nowrap' }}>
                      {r.qty}{r.unit ? ` ${r.unit}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ color: '#64748b', fontSize: '14px', margin: '12px 0' }}>
              This estimate doesn’t have a materials list. Generate or add materials to the quote first.
            </p>
          )}
        </div>

        {/* Actions */}
        {hasMaterialsList(estimate) && (
          <div style={{ borderTop: '1px solid #e2e8f0', padding: '14px 18px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            <button onClick={() => openMaterialsListPrintWindow(estimate, businessName)} style={{ ...btn, background: '#1a1f2e', color: 'white' }}>
              🖨️ Print / PDF
            </button>
            <button onClick={doShare} style={{ ...btn, background: '#f97316', color: 'white' }}>
              📤 Share
            </button>
            {shareMsg && <span style={{ fontSize: '12px', color: '#16a34a', fontWeight: 600 }}>{shareMsg}</span>}
            <span style={{ flex: 1 }} />
            <button onClick={onClose} style={{ ...btn, background: '#f1f5f9', color: '#1a1f2e' }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
