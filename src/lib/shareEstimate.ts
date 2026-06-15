import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { toCustomerView } from './customerView'
import type { Estimate } from '../data/types'

const sendCallable = httpsCallable<
  {
    clerkToken: string
    input: {
      to: string
      fromName?: string
      replyTo?: string
      subject?: string
      estimate: {
        customerName: string
        jobTypeName: string
        jobLocationZip?: string
        total: number
        rateType?: 'flat' | 'hourly'
        hourlyRate?: number
        estimatedHours?: number
        flatAmount?: number
        scopeOfWork?: string
        aiQuote?: ReturnType<typeof toCustomerView>
      }
    }
  },
  { ok: boolean; emailId?: string }
>(functions, 'sendEstimateEmail')

// Public URL the customer opens (no sign-in required).
// Hard-coded to the `.web.app` domain. The `.firebaseapp.com` domain is shared
// across many Firebase projects and has been falsely flagged by Google Safe
// Browsing; `.web.app` is a cleaner shared domain with fewer false positives.
import { PUBLIC_HOST } from './config'

export function shareLinkFor(estimateId: string): string {
  return `${PUBLIC_HOST}/q/${estimateId}`
}

// SMS share via the device's native messaging app.
// Cross-device gotchas this handles:
//  - iOS Safari requires `sms:&body=...` (no `?`) when there's no recipient.
//  - iPhone → Android conversions (iMessage → SMS) sometimes truncate long
//    messages or strip URL previews. So we keep the body SHORT and put the
//    URL on its own line FIRST so it survives carrier mangling.
//  - We use a plain http(s) URL — no fancy formatting that gets stripped.
export function smsHref(estimate: Estimate, fromName?: string): string {
  const link = shareLinkFor(estimate.id)
  // Short, link-first body. Stays under 160 chars to fit a single SMS segment.
  const body = `${link}\n\nYour proposal from ${fromName || 'your contractor'} for ${estimate.customerName}.`
  const encoded = encodeURIComponent(body)
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return `sms:&body=${encoded}`
  }
  return `sms:?body=${encoded}`
}

// mailto: opens the user's default email client (Gmail, Outlook, Apple Mail,
// etc.) with subject + body pre-filled. Works on EVERY device: phone, tablet,
// laptop, desktop. Customer types in the recipient address themselves.
export function mailtoHref(estimate: Estimate, fromName?: string): string {
  const link = shareLinkFor(estimate.id)
  const subject = `Your proposal for ${estimate.jobTypeName}`
  const body = `Hi ${estimate.customerName},

Here's your proposal from ${fromName || 'your contractor'}:

${link}

Let me know if you have any questions.

— ${fromName || 'Your contractor'}`
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

// True on phones (iOS / Android), false on laptops/desktops. SMS app only
// exists on phones, so we hide the SMS button on desktop.
export function isPhone(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

// Strips markup from the AI quote before sending so the customer sees baked-in
// material prices, not a separate "markup" line.
export async function sendEstimateByEmail(args: {
  clerkToken: string
  estimate: Estimate
  to: string
  fromName?: string
  replyTo?: string
  subject?: string
}): Promise<void> {
  const { estimate, ...rest } = args
  const ai = estimate.aiQuote ? toCustomerView(estimate.aiQuote) : undefined
  const link = shareLinkFor(estimate.id)
  const scopeWithLink = (estimate.scopeOfWork || '') + `\n\nView this estimate online: ${link}`
  const res = await sendCallable({
    clerkToken: rest.clerkToken,
    input: {
      to: rest.to,
      fromName: rest.fromName,
      replyTo: rest.replyTo,
      subject: rest.subject,
      estimate: {
        customerName: estimate.customerName,
        jobTypeName: estimate.jobTypeName,
        jobLocationZip: estimate.jobLocationZip,
        total: estimate.total,
        rateType: estimate.rateType,
        hourlyRate: estimate.hourlyRate,
        estimatedHours: estimate.estimatedHours,
        flatAmount: estimate.flatAmount,
        scopeOfWork: scopeWithLink,
        aiQuote: ai,
      },
    },
  })
  if (!res.data?.ok) throw new Error('Email send did not confirm success')
}

// Opens the native OS share sheet (iOS / Android) so the user can pick
// Messages, WhatsApp, Mail, etc. Falls back to false if not supported.
//
// iPhone → Android caveat: when an iPhone user shares to Messages, iOS sends
// it as an iMessage that gets converted to SMS for Android recipients. SMS
// carriers sometimes strip the rich URL preview from `navigator.share` calls
// that pass a `url`. So we ALSO put the link in the `text` field — that way
// the link appears in the body regardless of what carrier conversion strips.
export async function nativeShare(estimate: Estimate, fromName?: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.share) return false
  const link = shareLinkFor(estimate.id)
  // Link first, short context after. Survives SMS truncation.
  const text = `${link}\n\nYour proposal from ${fromName || 'your contractor'} for ${estimate.customerName}.`
  try {
    await navigator.share({
      title: `Proposal for ${estimate.customerName}`,
      text,
      // Keeping `url` too lets apps that support rich previews (WhatsApp, Mail)
      // pick it up cleanly; messaging apps that strip it still get the text body.
      url: link,
    })
    return true
  } catch {
    // User cancelled or share failed — caller can fall back to other options.
    return false
  }
}

export async function copyShareLink(estimateId: string): Promise<boolean> {
  const link = shareLinkFor(estimateId)
  try {
    await navigator.clipboard.writeText(link)
    return true
  } catch {
    // Older browsers / no clipboard permission — leave caller to fall back.
    return false
  }
}
