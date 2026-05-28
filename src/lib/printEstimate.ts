import { toCustomerView } from './customerView'
import type { Estimate } from '../data/types'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

interface PrintProfile {
  businessName?: string
  businessPhone?: string
  businessEmail?: string
  licenseNumber?: string
  logoUrl?: string
}

// Opens a print-ready window for an estimate. Customer-facing: markup is
// baked into material prices, no markup line, with full materials list + labor
// breakdown + totals + branded letterhead. If a profile is passed, the
// header uses the contractor's brand + logo + contact info; otherwise the
// BuildPro+ wordmark.
//
// The 2nd arg accepts either a string (legacy: just the business name) or
// a full profile object.
export function openEstimatePrintWindow(e: Estimate, profileOrName?: string | PrintProfile): void {
  const profile: PrintProfile = typeof profileOrName === 'string'
    ? { businessName: profileOrName }
    : (profileOrName || {})
  const businessName = profile.businessName?.trim() || ''
  const businessPhone = profile.businessPhone?.trim() || ''
  const businessEmail = profile.businessEmail?.trim() || ''
  const licenseNumber = profile.licenseNumber?.trim() || ''
  const logoUrl = profile.logoUrl?.trim() || ''
  const contactBits = [businessPhone, businessEmail, licenseNumber ? `Lic. ${licenseNumber}` : ''].filter(Boolean)
  const w = window.open('', '_blank', 'width=900,height=1000')
  if (!w) {
    alert('Popup blocked. Allow popups for this site and try again.')
    return
  }
  // Customer-facing view: markup distributed into material unit prices.
  const ai = e.aiQuote ? toCustomerView(e.aiQuote) : undefined

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Estimate — ${esc(e.customerName)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #1a1f2e; }
      .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #f97316; padding-bottom: 12px; margin-bottom: 20px; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-mark { width: 36px; height: 36px; background: #f97316; border-radius: 8px; color: white; font-weight: 800; font-size: 20px; display: inline-flex; align-items: center; justify-content: center; }
      .brand-name { font-size: 18px; font-weight: 800; color: #1a1f2e; letter-spacing: -0.5px; }
      .brand-tag { font-size: 10px; color: #64748b; letter-spacing: 1px; text-transform: uppercase; }
      h1 { color: #f97316; font-size: 24px; margin: 0; }
      h2 { color: #1a1f2e; margin-top: 24px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
      pre { white-space: pre-wrap; font-family: inherit; background: #f8fafc; padding: 12px; border-radius: 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
      th, td { padding: 8px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; }
      th { background: #f8fafc; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; color: #475569; }
      .total-box { background: #1a1f2e; color: white; padding: 18px 22px; border-radius: 10px; margin-top: 24px; }
      .total-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
      .total-row .label { color: #cbd5e1; }
      .total-row .value { font-weight: 600; }
      .total-grand { display: flex; justify-content: space-between; align-items: center; border-top: 2px solid #f97316; padding-top: 12px; margin-top: 12px; }
      .total-label { color: #fb923c; text-transform: uppercase; letter-spacing: 1.5px; font-size: 13px; font-weight: 700; }
      .total-amount { font-size: 32px; color: #f97316; font-weight: 800; }
      .meta { color: #64748b; font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
      .footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; text-align: center; }
      @media print { body { padding: 20px; } }
    </style></head><body>
    <div class="header">
      <div class="brand">
        ${logoUrl
          ? `<span class="brand-mark" style="background:white;border:1px solid #e2e8f0;"><img src="${esc(logoUrl)}" alt="logo" style="width:100%;height:100%;object-fit:contain;"/></span>`
          : `<span class="brand-mark">${esc(businessName[0]?.toUpperCase() || 'B')}</span>`
        }
        <div>
          ${businessName ? `
            <div class="brand-name">${esc(businessName)}</div>
            <div class="brand-tag">Powered by BuildPro+</div>
          ` : `
            <div class="brand-name">BuildPro<span style="color:#f97316;">+</span></div>
            <div class="brand-tag">Contractor Estimate</div>
          `}
        </div>
      </div>
      <h1>Estimate</h1>
    </div>
    ${contactBits.length > 0 ? `<p style="color:#64748b;font-size:12px;margin:-8px 0 16px;">${contactBits.map(esc).join(' · ')}</p>` : ''}
    <p class="meta"><strong>Customer:</strong> ${esc(e.customerName)}<br/>
    <strong>Job:</strong> ${esc(e.jobTypeName)}<br/>
    ${e.jobLocationZip ? `<strong>Location:</strong> ZIP ${esc(e.jobLocationZip)}<br/>` : ''}
    <strong>Date:</strong> ${esc(new Date(e.createdAt).toLocaleDateString())}</p>

    ${ai ? `
      <h2>Summary</h2>
      <p>${esc(ai.customer_summary)}</p>

      <h2>Work Scope</h2>
      <pre>${esc(ai.work_scope)}</pre>

      ${ai.material_list.length > 0 ? `
        <h2>Materials</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align:right;">Qty</th>
              <th>Unit</th>
              <th style="text-align:right;">Unit $</th>
              <th style="text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${ai.material_list.map(m => `
              <tr>
                <td>${esc(m.name)}</td>
                <td style="text-align:right;">${esc(m.quantity_with_waste)}</td>
                <td>${esc(m.unit)}</td>
                <td style="text-align:right;">$${m.unit_price.toFixed(2)}</td>
                <td style="text-align:right;font-weight:600;">$${m.line_total.toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}

      <h2>Labor</h2>
      <p>${esc(ai.labor.estimated_hours)} hours @ $${ai.labor.hourly_rate}/hr — <strong>$${ai.labor.labor_total.toFixed(2)}</strong></p>

      <div class="total-box">
        <div class="total-row"><span class="label">Materials</span><span class="value">$${ai.price_breakdown.materials_subtotal.toFixed(2)}</span></div>
        <div class="total-row"><span class="label">Labor (${ai.labor.estimated_hours}h × $${ai.labor.hourly_rate}/hr)</span><span class="value">$${ai.price_breakdown.labor_subtotal.toFixed(2)}</span></div>
        ${ai.price_breakdown.rentals_subtotal > 0 ? `<div class="total-row"><span class="label">Rentals</span><span class="value">$${ai.price_breakdown.rentals_subtotal.toFixed(2)}</span></div>` : ''}
        <div class="total-grand">
          <span class="total-label">Total</span>
          <span class="total-amount">$${ai.final_customer_quote.toFixed(2)}</span>
        </div>
      </div>
    ` : `
      <h2>Scope of Work</h2>
      <pre>${esc(e.scopeOfWork || '')}</pre>
      <div class="total-box">
        <div class="total-grand">
          <span class="total-label">Total</span>
          <span class="total-amount">$${(e.total || 0).toFixed(2)}</span>
        </div>
      </div>
    `}

    <div class="footer">Generated by BuildPro+ · ${esc(new Date().toLocaleString())}</div>
    <script>setTimeout(() => window.print(), 400)</script>
    </body></html>`)
  w.document.close()
}
