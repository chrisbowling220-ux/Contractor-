import { useState, useMemo, useRef, useEffect } from 'react'
import { useAuth, useUser } from '@clerk/clerk-react'
import { collection, doc, updateDoc, deleteField, writeBatch } from 'firebase/firestore'
import { db } from './firebase'
import { isSignedEstimate, revisionFields, revisionNumber } from './lib/estimateRevision'
import { toCustomerView } from './lib/customerView'
import { quoteFromManualEstimate } from './lib/manualQuote'
import { copyShareLink, shareLinkFor, smsHref, mailtoHref, nativeShare, isPhone } from './lib/shareEstimate'
import { rememberMaterialPrices } from './lib/learnedPrices'
import { generateProposalLetter, buildProposalFallback } from './lib/proposal'
import { fetchBusinessProfile } from './lib/businessProfile'
import MaterialsListModal from './MaterialsListModal'
import ProposalEditor from './ProposalEditor'
import type { Estimate, AIQuote, AIMaterialLine, ProposalLetter } from './data/types'

interface Props {
  estimate: Estimate
  onClose: () => void
  onSaved: (updated: Estimate) => void
  onPrint: (e: Estimate) => void
  // Business name for the materials-list letterhead. Optional.
  businessName?: string
}

// Editable customer-facing preview of an estimate. Edits are saved back to
// Firestore on Save; the public share view, print, SMS link, and Copy link all
// pull from the saved version.
export default function EstimatePreview({ estimate, onClose, onSaved, onPrint, businessName }: Props) {
  const { user } = useUser()
  const { getToken } = useAuth()

  // A signed (approved) estimate is a legal record and is never edited:
  // saving creates the next revision instead (lib/estimateRevision.ts). A
  // version that has already been replaced is read-only.
  const signed = isSignedEstimate(estimate)
  const superseded = !!estimate.supersededBy
  const nextRevision = revisionNumber(estimate) + 1
  // The version this editor is showing right now. Saving a signed estimate
  // switches it to the new revision part-way through "save, then send", so
  // the send step must read this rather than the `estimate` it started with.
  const current = useRef(estimate)
  useEffect(() => { current.current = estimate }, [estimate])

  // Always work from a customer-view shaped quote so markup is baked in.
  // A hand-built estimate has no itemised quote; build one from its own fields
  // so its materials and labor show up here (and survive a save).
  const initialAi: AIQuote = estimate.aiQuote ? toCustomerView(estimate.aiQuote) : quoteFromManualEstimate(estimate)

  const [customerName, setCustomerName] = useState(estimate.customerName || '')
  const [customerSummary, setCustomerSummary] = useState(initialAi?.customer_summary || '')
  const [workScope, setWorkScope] = useState(initialAi?.work_scope || estimate.scopeOfWork || '')
  const [materials, setMaterials] = useState<AIMaterialLine[]>(initialAi?.material_list || [])
  const [hourlyRate, setHourlyRate] = useState(String(initialAi?.labor.hourly_rate ?? estimate.hourlyRate ?? 65))
  const [estimatedHours, setEstimatedHours] = useState(String(initialAi?.labor.estimated_hours ?? estimate.estimatedHours ?? 0))
  const [rentalsTotal, setRentalsTotal] = useState(String(initialAi?.price_breakdown.rentals_subtotal ?? estimate.rentalsTotal ?? 0))
  const [contractorNotes, setContractorNotes] = useState(initialAi?.contractor_notes || '')
  // Optional upfront deposit (off by default).
  const [depositRequested, setDepositRequested] = useState(!!estimate.depositRequested)
  const [depositAmount, setDepositAmount] = useState(String(estimate.depositAmount ?? ''))
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [materialsModalOpen, setMaterialsModalOpen] = useState(false)
  // Professional proposal letter — the customer's first paperwork. Generated
  // once (AI, with a template fallback) and saved on the estimate; the
  // contractor can edit it before sending.
  const [proposal, setProposal] = useState<ProposalLetter | null>(estimate.proposal || null)
  const [proposalEdited, setProposalEdited] = useState(!!estimate.proposalEdited)
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalOpen, setProposalOpen] = useState(false)
  // Unsaved changes = the fields differ from what was last saved. (Changing a
  // value and changing it back is clean again.)
  const fieldsKey = JSON.stringify([customerName, customerSummary, workScope, materials, hourlyRate, estimatedHours, rentalsTotal, contractorNotes, depositRequested, depositAmount])
  const [savedKey, setSavedKey] = useState(fieldsKey)
  const dirty = fieldsKey !== savedKey

  // Live recalculation. Markup is baked into materials already (customer view),
  // so total = labor + materials + rentals.
  const computed = useMemo(() => {
    const materialsSubtotal = +materials.reduce((s, m) => s + (Number(m.line_total) || 0), 0).toFixed(2)
    const laborSubtotal = +((Number(hourlyRate) || 0) * (Number(estimatedHours) || 0)).toFixed(2)
    const rentals = Number(rentalsTotal) || 0
    const total = +(materialsSubtotal + laborSubtotal + rentals).toFixed(2)
    return { materialsSubtotal, laborSubtotal, rentals, total }
  }, [materials, hourlyRate, estimatedHours, rentalsTotal])

  const updateMaterial = (i: number, patch: Partial<AIMaterialLine>) => {
    setMaterials(prev => prev.map((m, idx) => {
      if (idx !== i) return m
      const next = { ...m, ...patch }
      // Recompute line total whenever qty or unit price changes.
      next.line_total = +(Number(next.quantity_with_waste) * Number(next.unit_price)).toFixed(2)
      return next
    }))
  }

  const removeMaterial = (i: number) => setMaterials(prev => prev.filter((_, idx) => idx !== i))

  const addMaterial = () => {
    setMaterials(prev => [...prev, {
      name: 'New item',
      base_quantity: 1,
      waste_percent: 0,
      quantity_with_waste: 1,
      quantity_math: '',
      unit: 'each',
      unit_price: 0,
      line_total: 0,
    }])
  }

  const buildEditedQuote = (): AIQuote => ({
    customer_summary: customerSummary,
    work_scope: workScope,
    material_list: materials,
    labor: {
      estimated_hours: Number(estimatedHours) || 0,
      breakdown: initialAi?.labor.breakdown || '',
      hourly_rate: Number(hourlyRate) || 0,
      labor_total: computed.laborSubtotal,
    },
    price_breakdown: {
      labor_subtotal: computed.laborSubtotal,
      materials_subtotal: computed.materialsSubtotal,
      rentals_subtotal: computed.rentals,
      raw_cost: computed.total,
    },
    profit_markup: {
      markup_percent: 0,
      markup_dollars: 0,
      rationale: '',
    },
    final_customer_quote: computed.total,
    contractor_notes: contractorNotes,
  })

  const saveEdits = async () => {
    if (superseded) return
    setSaving(true)
    setSaveStatus('')
    try {
      const editedQuote = buildEditedQuote()
      const depAmt = depositRequested ? Math.min(Math.max(0, Number(depositAmount) || 0), computed.total) : 0
      const updates: Record<string, unknown> = {
        customerName,
        aiQuote: editedQuote,
        total: computed.total,
        laborTotal: computed.laborSubtotal,
        materialsTotal: computed.materialsSubtotal,
        rentalsTotal: computed.rentals,
        hourlyRate: Number(hourlyRate) || 0,
        estimatedHours: Number(estimatedHours) || 0,
        scopeOfWork: `SCOPE OF WORK — ${estimate.jobTypeName}\n\nCLIENT: ${customerName}\n\nSUMMARY:\n${customerSummary}\n\n${workScope}`,
        depositRequested: depositRequested && depAmt > 0,
        depositAmount: depositRequested ? depAmt : 0,
      }
      if (signed) {
        // The customer signed this version: leave it exactly as signed and
        // save the edits as the next revision, in one atomic write that also
        // points the signed version at its successor.
        if (!user?.id) throw new Error('Not signed in')
        const fields = revisionFields(estimate, updates, user.id)
        const ref = doc(collection(db, 'estimates'))
        const batch = writeBatch(db)
        batch.set(ref, fields)
        batch.update(doc(db, 'estimates', estimate.id), { supersededBy: ref.id })
        await batch.commit()
        const revision = { id: ref.id, ...fields } as Estimate
        current.current = revision
        // The proposal letter was written for the signed terms; a fresh one is
        // written for the revision when it is sent.
        setProposal(null)
        setProposalEdited(false)
        onSaved(revision)
        if (user?.id) rememberMaterialPrices(user.id, materials)
        setSavedKey(fieldsKey)
        setSaveStatus(`✓ Saved as Revision ${fields.revision}. The signed version is kept unchanged. Send this revision for the customer to sign.`)
        return revision
      }
      // If the customer DECLINED this estimate and the contractor is now
      // editing it to re-send, reset it to "pending" and clear the old response
      // so the customer gets a fresh Accept/Decline on the improved version
      // (instead of seeing the stale "Declined" screen). Nothing was signed, so
      // the same document is reused.
      const reset = estimate.status !== 'pending'
      const writePayload: Record<string, unknown> = { ...updates }
      if (reset) {
        writePayload.status = 'pending'
        writePayload.customerResponse = deleteField()
      }
      await updateDoc(doc(db, 'estimates', estimate.id), writePayload)
      const updated: Estimate = {
        ...estimate,
        ...updates,
        ...(reset ? { status: 'pending' as const, customerResponse: undefined } : {}),
      } as Estimate
      current.current = updated
      onSaved(updated)
      // Learn the contractor's edited material prices for smarter future quotes.
      if (user?.id) rememberMaterialPrices(user.id, materials)
      setSavedKey(fieldsKey)
      setSaveStatus('✓ Saved')
      setTimeout(() => setSaveStatus(''), 2500)
      return updated
    } catch (err) {
      setSaveStatus('⚠ Save failed: ' + (err instanceof Error ? err.message : String(err)))
      return null
    } finally {
      setSaving(false)
    }
  }

  // Sends always act on the version the customer should see: after a save
  // that created a revision, that is the revision, not the signed original.
  const saveThenSend = async (action: (target: Estimate) => void | Promise<void>) => {
    if (dirty && !superseded) {
      const question = signed
        ? `You have unsaved edits. Save them as Revision ${nextRevision} and send that for the customer to sign?`
        : 'You have unsaved edits. Save before sharing?'
      if (!confirm(question)) return
      if (!(await saveEdits())) return
    }
    // The proposal is the customer's first paperwork — make sure it exists
    // before any share/copy/print so the customer always receives it.
    await ensureProposal()
    await action(current.current)
  }

  const fromName = user?.fullName || user?.firstName || undefined

  // Build the proposal context (brand + signer) from the business profile and
  // the signed-in contractor's name. businessName prop is the brand; the
  // license # comes from the saved profile.
  const proposalCtx = async () => {
    let licenseNumber = ''
    let bizName = businessName || ''
    try {
      if (user?.id) {
        const p = await fetchBusinessProfile(user.id)
        licenseNumber = p.licenseNumber || ''
        bizName = bizName || p.businessName || ''
      }
    } catch { /* non-fatal — proposal still generates without it */ }
    return { businessName: bizName || undefined, contractorName: fromName, licenseNumber: licenseNumber || undefined }
  }

  // Persist a proposal letter onto the estimate doc (and local state). `edited`
  // marks a hand-edited version so a future regenerate won't silently clobber it.
  const persistProposal = async (p: ProposalLetter, edited: boolean) => {
    const target = current.current
    // The letter is part of what the customer signed.
    if (isSignedEstimate(target)) {
      setSaveStatus(`🔒 The customer signed with this letter, so it can't change. Save your edits as Revision ${revisionNumber(target) + 1} to send a new one.`)
      return
    }
    setProposal(p)
    setProposalEdited(edited)
    try {
      await updateDoc(doc(db, 'estimates', target.id), { proposal: p, proposalEdited: edited })
      const updated = { ...target, proposal: p, proposalEdited: edited } as Estimate
      current.current = updated
      onSaved(updated)
    } catch (err) {
      console.error('Failed to save proposal', err)
    }
  }

  // Generate the proposal via AI (template fallback on failure) and save it.
  // Called on first send/open and on an explicit "regenerate". Returns the
  // proposal so the send flow can proceed regardless of AI success.
  const generateAndSaveProposal = async (): Promise<ProposalLetter> => {
    setProposalBusy(true)
    try {
      const ctx = await proposalCtx()
      const edited = { ...current.current, aiQuote: buildEditedQuote(), customerName, total: computed.total } as Estimate
      let letter: ProposalLetter
      try {
        const token = await getToken()
        if (!token) throw new Error('Not signed in')
        letter = await generateProposalLetter(token, edited, ctx)
      } catch (err) {
        // AI unavailable — never block the customer's paperwork. Use the
        // clean professional template instead.
        console.warn('Proposal AI failed, using template fallback:', err)
        letter = buildProposalFallback(edited, ctx)
      }
      await persistProposal(letter, false)
      return letter
    } finally {
      setProposalBusy(false)
    }
  }

  // Ensure a proposal exists before sending. If one is already saved, keep it
  // (never overwrite the contractor's edited copy); otherwise generate one.
  // A signed or replaced version is sent exactly as it stands.
  const ensureProposal = async (): Promise<void> => {
    const target = current.current
    if (proposal || isSignedEstimate(target) || target.supersededBy) return
    await generateAndSaveProposal()
  }

  const doShare = () => saveThenSend(async (target) => {
    const ok = await nativeShare(target, fromName)
    if (!ok) {
      const copied = await copyShareLink(target.id)
      if (copied) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500) }
    }
  })

  const doCopy = () => saveThenSend(async (target) => {
    const ok = await copyShareLink(target.id)
    if (ok) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500) }
    else setSaveStatus(`Manual link: ${shareLinkFor(target.id)}`)
  })

  // A replaced version prints exactly as it was saved, not with the form's
  // (read-only) values.
  const doPrint = () => saveThenSend(async (target) => {
    onPrint(superseded ? target : { ...target, aiQuote: buildEditedQuote(), customerName, total: computed.total } as Estimate)
  })

  // Text and email links carry the estimate link in their href, built before
  // any save. When unsaved edits would become a NEW revision, that href still
  // points at the signed version, so ask for the save first.
  const linkSaveFirst = (ev: React.MouseEvent) => {
    if (!dirty || superseded) return
    if (signed) {
      ev.preventDefault()
      setSaveStatus(`Save your edits as Revision ${nextRevision} first, then send the new version.`)
      return
    }
    void saveEdits()
  }

  // The materials shopping list is the contractor's OWN list, not sent to the
  // customer — so it's always available, even on an unsaved draft. It reflects
  // the current edits (buildEditedQuote), no save required. Opens in an in-app
  // modal (NOT a popup window) so closing it returns here instead of stranding
  // the user with no back button.
  const editedEstimateForMaterials = (): Estimate =>
    ({ ...estimate, aiQuote: buildEditedQuote(), customerName } as Estimate)

  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '12px', border: '1px solid #e2e8f0' }

  return (
   <>
    {materialsModalOpen && (
      <MaterialsListModal
        estimate={editedEstimateForMaterials()}
        businessName={businessName}
        onClose={() => setMaterialsModalOpen(false)}
      />
    )}
    {proposalOpen && proposal && (
      <ProposalEditor
        proposal={proposal}
        busy={proposalBusy}
        onSave={(p, edited) => persistProposal(p, edited)}
        onRegenerate={async () => { await generateAndSaveProposal() }}
        onClose={() => setProposalOpen(false)}
      />
    )}
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 200, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '780px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f97316', fontSize: '18px' }}>
              {superseded ? 'Signed Estimate (replaced)' : signed ? 'Signed Estimate' : 'Edit & Send Estimate'}
              {revisionNumber(estimate) > 1 && <span style={{ color: '#cbd5e1', fontWeight: 600 }}> · Revision {revisionNumber(estimate)}</span>}
            </h2>
            <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>Customer-facing preview. Markup is baked in — no markup line is shown.</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: 'white', border: '1px solid #475569', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}>Close</button>
        </div>

        <div style={{ padding: '16px' }}>
          {signed && (
            <div role="note" style={{ background: superseded ? '#f1f5f9' : '#f0fdf4', border: `1px solid ${superseded ? '#cbd5e1' : '#86efac'}`, borderRadius: '8px', padding: '12px 14px', marginBottom: '12px', fontSize: '13px', color: '#1a1f2e', lineHeight: 1.5 }}>
              <p style={{ margin: 0, fontWeight: 700 }}>
                🔒 Signed by {estimate.customerResponse?.signedName || estimate.customerName}
                {estimate.customerResponse?.respondedAt ? ` on ${new Date(estimate.customerResponse.respondedAt).toLocaleDateString()}` : ''}. This version is a legal record and can't be changed.
              </p>
              <p style={{ margin: '4px 0 0', color: '#475569' }}>
                {superseded
                  ? 'A newer revision has replaced it. It stays on file exactly as signed. Open the latest version from your estimates to make changes.'
                  : `To change the job, edit below and save: that creates Revision ${nextRevision} for the customer to review and sign. This signed version stays on file, and stays the one you bill until they sign the revision.`}
              </p>
            </div>
          )}

          {/* A replaced version is read-only: every field below is disabled. */}
          <fieldset disabled={superseded} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {/* Header card — customer name */}
          <div style={card}>
            <label style={label}>Customer Name</label>
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} style={input} />
            <p style={{ fontSize: '12px', color: '#64748b', margin: '6px 0 0' }}>
              {estimate.jobTypeName} · ZIP {estimate.jobLocationZip} · {new Date(estimate.createdAt).toLocaleDateString()}
            </p>
          </div>

          {/* Customer summary */}
          <div style={card}>
            <label style={label}>Customer Summary (prose paragraph shown to the customer)</label>
            <textarea value={customerSummary} onChange={e => setCustomerSummary(e.target.value)} rows={4} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
          </div>

          {/* Work scope */}
          <div style={card}>
            <label style={label}>Work Scope</label>
            <textarea value={workScope} onChange={e => setWorkScope(e.target.value)} rows={8} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
          </div>

          {/* Materials */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={label as React.CSSProperties}>Materials</span>
              <button onClick={addMaterial} style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>+ Add item</button>
            </div>
            {materials.length === 0 && <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>No materials. Click + Add item to include some.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {materials.map((m, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr)) auto', gap: '8px', alignItems: 'end' }}>
                  <div style={{ gridColumn: '1 / -2' }}>
                    <label style={{ ...label, fontSize: '10px' }}>Item</label>
                    <input value={m.name} onChange={e => updateMaterial(i, { name: e.target.value })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Qty</label>
                    <input type="number" value={m.quantity_with_waste} onChange={e => updateMaterial(i, { quantity_with_waste: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Unit</label>
                    <input value={m.unit} onChange={e => updateMaterial(i, { unit: e.target.value })} style={input} />
                  </div>
                  <div>
                    <label style={{ ...label, fontSize: '10px' }}>Unit $</label>
                    <input type="number" step="0.01" value={m.unit_price} onChange={e => updateMaterial(i, { unit_price: Number(e.target.value) || 0 })} style={input} />
                  </div>
                  <div style={{ minWidth: '70px', textAlign: 'right', fontWeight: 700, fontSize: '14px' }}>
                    ${m.line_total.toFixed(2)}
                  </div>
                  <button onClick={() => removeMaterial(i)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '6px' }}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Labor */}
          <div style={card}>
            <span style={label as React.CSSProperties}>Labor</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Estimated Hours</label>
                <input type="number" step="0.25" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} style={input} />
              </div>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Hourly Rate ($/hr)</label>
                <input type="number" step="1" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} style={input} />
              </div>
              <div>
                <label style={{ ...label, fontSize: '10px' }}>Labor Total</label>
                <div style={{ padding: '8px 10px', background: '#f1f5f9', borderRadius: '6px', fontWeight: 700, fontSize: '14px' }}>${computed.laborSubtotal.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Rentals (simple editable total, kept lightweight) */}
          {(computed.rentals > 0 || Number(rentalsTotal) > 0) && (
            <div style={card}>
              <label style={label}>Rentals Total</label>
              <input type="number" step="0.01" value={rentalsTotal} onChange={e => setRentalsTotal(e.target.value)} style={input} />
            </div>
          )}

          {/* Contractor notes */}
          <div style={card}>
            <label style={label}>🔒 Contractor Notes (private — not shown to customer)</label>
            <textarea value={contractorNotes} onChange={e => setContractorNotes(e.target.value)} rows={3} style={{ ...input, fontFamily: 'inherit', resize: 'vertical', background: '#fef3c7' }} />
          </div>

          {/* Live totals */}
          <div style={{ ...card, background: '#1a1f2e', color: 'white', border: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Materials</span><span style={{ fontWeight: 600 }}>${computed.materialsSubtotal.toFixed(2)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Labor ({estimatedHours}h × ${hourlyRate}/hr)</span><span style={{ fontWeight: 600 }}>${computed.laborSubtotal.toFixed(2)}</span></div>
            {computed.rentals > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px' }}><span style={{ color: '#cbd5e1' }}>Rentals</span><span style={{ fontWeight: 600 }}>${computed.rentals.toFixed(2)}</span></div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #f97316', paddingTop: '12px', marginTop: '8px' }}>
              <span style={{ color: '#fb923c', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Grand Total</span>
              <span style={{ color: '#f97316', fontSize: '28px', fontWeight: 700 }}>${computed.total.toFixed(2)}</span>
            </div>
          </div>

          {/* Optional upfront deposit — off by default. Some jobs/customers
              prefer to pay only at completion, so the contractor chooses. */}
          <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', marginTop: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', color: '#1a1f2e' }}>
              <input type="checkbox" checked={depositRequested} onChange={e => setDepositRequested(e.target.checked)} style={{ width: '18px', height: '18px', cursor: 'pointer' }} />
              💵 Request an upfront deposit before starting
            </label>
            {depositRequested && (
              <div style={{ marginTop: '12px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>Deposit amount $</span>
                  <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="0.00" style={{ width: '120px', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px' }} />
                  {/* Quick % helpers */}
                  {[25, 50].map(pct => (
                    <button key={pct} onClick={() => setDepositAmount((computed.total * pct / 100).toFixed(2))} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>{pct}%</button>
                  ))}
                </div>
                {Number(depositAmount) > 0 && (
                  <p style={{ margin: 0, fontSize: '13px', color: '#16a34a', fontWeight: 600 }}>
                    Customer pays <strong>${(Number(depositAmount) || 0).toFixed(2)}</strong> upfront · <strong>${Math.max(0, computed.total - (Number(depositAmount) || 0)).toFixed(2)}</strong> balance due at completion.
                  </p>
                )}
                <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#94a3b8' }}>When the customer approves, a deposit invoice is created automatically. Leave this off if they'll pay only at the end.</p>
              </div>
            )}
          </div>

          </fieldset>

          {/* Save + share row */}
          <div style={{ position: 'sticky', bottom: 0, background: 'rgba(248,250,252,0.95)', backdropFilter: 'blur(4px)', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0', marginTop: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {!superseded && (
                <button onClick={saveEdits} disabled={saving || !dirty} style={{ background: dirty ? '#f97316' : '#cbd5e1', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: dirty ? 'pointer' : 'not-allowed', fontWeight: 700 }}>
                  {saving ? 'Saving…' : !dirty ? '✓ Up to date' : signed ? `💾 Save as Revision ${nextRevision}` : '💾 Save Changes'}
                </button>
              )}
              <div style={{ width: '1px', height: '24px', background: '#cbd5e1', margin: '0 4px' }} />
              {/* Native share sheet — phones only. On desktops navigator.share is
                  unavailable; doShare falls back to copy-link automatically. */}
              {isPhone() && (
                <button onClick={doShare} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                  📤 Share
                </button>
              )}
              {/* SMS link — phones only (laptops don't have an SMS app). */}
              {isPhone() && (
                <a href={smsHref({ ...estimate, customerName }, fromName)} onClick={linkSaveFirst} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
                  💬 Text
                </a>
              )}
              {/* Email link — works on every device. Opens user's default mail app. */}
              <a href={mailtoHref({ ...estimate, customerName }, fromName)} onClick={linkSaveFirst} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, textDecoration: 'none', color: '#1a1f2e', display: 'inline-block' }}>
                ✉️ Email
              </a>
              <button onClick={doCopy} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                {linkCopied ? '✓ Copied' : '🔗 Copy link'}
              </button>
              <button onClick={doPrint} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                🖨️ Print / PDF
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#64748b' }}>
              <strong>Copy link</strong> works on any device and any messaging app — paste it anywhere. <strong>Text/Share</strong> only on phones.
            </p>
            {saveStatus && <p style={{ margin: '8px 0 0', fontSize: '13px', color: saveStatus.startsWith('✓') ? '#16a34a' : '#dc2626' }}>{saveStatus}</p>}
          </div>

          {/* Proposal letter — the customer's FIRST paperwork. Auto-generated
              on send; the contractor can review/edit/regenerate it here. */}
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '14px', marginTop: '12px' }}>
            <div style={{ fontWeight: 800, color: '#1e3a8a', fontSize: '14px', marginBottom: '2px' }}>📄 Professional Proposal</div>
            <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#1e40af', lineHeight: 1.5 }}>
              {signed
                ? (proposal
                    ? 'The customer signed with this letter, so it stays as it is. A revision gets a fresh letter written for its new terms.'
                    : 'This estimate was signed without a proposal letter. A revision gets one written for its new terms when you send it.')
                : proposal
                  ? 'This polished proposal letter is what your customer sees first, above the estimate. Review or tweak it before sending.'
                  : 'A professional proposal letter is written automatically when you send — it frames your estimate for the customer. You can preview and edit it now.'}
            </p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {proposal ? (
                <button onClick={() => setProposalOpen(true)} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                  {signed ? '📄 View Proposal' : '📄 View / Edit Proposal'}
                </button>
              ) : signed ? null : (
                <button onClick={async () => { await generateAndSaveProposal(); setProposalOpen(true) }} disabled={proposalBusy} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: proposalBusy ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
                  {proposalBusy ? 'Writing…' : '✍️ Preview Proposal'}
                </button>
              )}
              {proposalEdited && <span style={{ fontSize: '12px', color: '#16a34a', fontWeight: 700 }}>✓ Edited by you</span>}
            </div>
          </div>

          {/* Materials shopping list — contractor-facing, NOT sent to the
              customer. Always available (even before the quote is sent or
              accepted) so they can take it to the store. Only shown when the
              quote actually has materials to buy. */}
          {materials.length > 0 && (
            <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '14px', marginTop: '12px' }}>
              <div style={{ fontWeight: 800, color: '#9a3412', fontSize: '14px', marginBottom: '2px' }}>🧰 Materials Shopping List</div>
              <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#7c2d12', lineHeight: 1.5 }}>
                Your pickup/ordering list — just the items and quantities, no prices. Open it to print or text it to yourself or the store’s pro desk.
              </p>
              <button onClick={() => setMaterialsModalOpen(true)} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                🛒 View Materials List
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
   </>
  )
}
