import type { Estimate } from '../data/types'

// The contractor's SHOPPING list — pulled straight out of the quote's material
// list. This is intentionally NOT customer-facing: no prices, no markup, no
// totals. Just the item + the real quantity to buy (waste already included) as
// a printable / shareable checklist for ordering, pickup, or a store pull.

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

interface ListProfile {
  businessName?: string
}

interface MaterialRow {
  name: string
  qty: number
  unit: string
}

// Pull the buy-quantities out of an estimate's AI quote. Returns [] if the
// estimate has no material list (e.g. a manually-built or scope-only estimate).
export function materialRowsFromEstimate(e: Estimate): MaterialRow[] {
  const list = e.aiQuote?.material_list
  if (!Array.isArray(list)) return []
  return list
    .filter(m => m && m.name)
    .map(m => ({
      // quantity_with_waste is what they actually need to buy; fall back to
      // base_quantity, then 1, so a row never shows a blank/zero quantity.
      name: String(m.name),
      qty: Number(m.quantity_with_waste) || Number(m.base_quantity) || 1,
      unit: String(m.unit || '').trim(),
    }))
}

// True when there's a material list worth sharing/printing.
export function hasMaterialsList(e: Estimate): boolean {
  return materialRowsFromEstimate(e).length > 0
}

// Format the list as a clean plain-text checklist — used for the native share
// sheet (text/email) and as the clipboard fallback. Each row is a checkbox so
// it doubles as a pick list.
export function materialsListAsText(e: Estimate, businessName?: string): string {
  const rows = materialRowsFromEstimate(e)
  const header = [
    businessName?.trim() ? businessName.trim() : 'BuildPro+',
    `Materials List — ${e.customerName || 'Job'}`,
    e.jobTypeName ? e.jobTypeName : '',
    `Date: ${new Date(e.createdAt || Date.now()).toLocaleDateString()}`,
  ].filter(Boolean).join('\n')
  const lines = rows.map(r => {
    const qtyUnit = r.unit ? `${r.qty} ${r.unit}` : `${r.qty}`
    return `[ ]  ${r.name} — ${qtyUnit}`
  })
  return `${header}\n\n${lines.join('\n')}\n`
}

// Opens a print-ready window for the materials shopping list. Matches the
// estimate print style (orange/navy letterhead) but with NO prices — just the
// item, quantity, and a checkbox column.
export function openMaterialsListPrintWindow(e: Estimate, profileOrName?: string | ListProfile): void {
  const profile: ListProfile = typeof profileOrName === 'string'
    ? { businessName: profileOrName }
    : (profileOrName || {})
  const businessName = profile.businessName?.trim() || ''
  const rows = materialRowsFromEstimate(e)

  const w = window.open('', '_blank', 'width=900,height=1000')
  if (!w) {
    alert('Popup blocked. Allow popups for this site and try again.')
    return
  }

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Materials List — ${esc(e.customerName)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1f2e; }
      .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #f97316; padding-bottom: 12px; margin-bottom: 20px; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-mark { width: 36px; height: 36px; background: #f97316; border-radius: 8px; color: white; font-weight: 800; font-size: 20px; display: inline-flex; align-items: center; justify-content: center; }
      .brand-name { font-size: 18px; font-weight: 800; color: #1a1f2e; letter-spacing: -0.5px; }
      .brand-tag { font-size: 10px; color: #64748b; letter-spacing: 1px; text-transform: uppercase; }
      h1 { color: #f97316; font-size: 24px; margin: 0; }
      .meta { color: #64748b; font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 8px 0; }
      th, td { padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: left; }
      th { background: #f8fafc; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; color: #475569; }
      .chk { width: 28px; text-align: center; }
      .box { display: inline-block; width: 16px; height: 16px; border: 2px solid #94a3b8; border-radius: 3px; }
      .qty { text-align: right; font-weight: 700; white-space: nowrap; }
      .footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; text-align: center; }
      @media print { body { padding: 20px; } }
    </style></head><body>
    <div class="header">
      <div class="brand">
        <span class="brand-mark">${esc(businessName[0]?.toUpperCase() || 'B')}</span>
        <div>
          ${businessName ? `
            <div class="brand-name">${esc(businessName)}</div>
            <div class="brand-tag">Powered by BuildPro+</div>
          ` : `
            <div class="brand-name">BuildPro<span style="color:#f97316;">+</span></div>
            <div class="brand-tag">Materials List</div>
          `}
        </div>
      </div>
      <h1>Materials</h1>
    </div>
    <p class="meta"><strong>Job:</strong> ${esc(e.customerName)}${e.jobTypeName ? ` — ${esc(e.jobTypeName)}` : ''}<br/>
    ${e.jobLocationZip ? `<strong>Location:</strong> ZIP ${esc(e.jobLocationZip)}<br/>` : ''}
    <strong>Date:</strong> ${esc(new Date(e.createdAt || Date.now()).toLocaleDateString())}</p>

    ${rows.length > 0 ? `
      <table>
        <thead>
          <tr><th class="chk"></th><th>Item</th><th style="text-align:right;">Qty</th><th>Unit</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="chk"><span class="box"></span></td>
              <td>${esc(r.name)}</td>
              <td class="qty">${esc(r.qty)}</td>
              <td>${esc(r.unit)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : `<p style="color:#64748b;">No materials are listed on this estimate.</p>`}

    <div class="footer">Materials shopping list · Generated by BuildPro+ · ${esc(new Date().toLocaleString())}</div>
    <script>setTimeout(() => window.print(), 400)</script>
    </body></html>`)
  w.document.close()
}

// Share the materials list via the native share sheet (text/email/etc.). Falls
// back to copying to the clipboard when the Web Share API isn't available
// (most desktop browsers), so the action always does something useful.
// Returns a short status the caller can flash to the user.
export async function shareMaterialsList(e: Estimate, businessName?: string): Promise<'shared' | 'copied' | 'failed'> {
  const text = materialsListAsText(e, businessName)
  const title = `Materials List — ${e.customerName || 'Job'}`
  try {
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> }
    if (typeof nav.share === 'function') {
      await nav.share({ title, text })
      return 'shared'
    }
  } catch (err) {
    // User cancelled the share sheet, or it failed — fall through to clipboard.
    if (err instanceof DOMException && err.name === 'AbortError') return 'failed'
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
