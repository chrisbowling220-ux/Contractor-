import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import type { Estimate, ProposalLetter } from '../data/types'

// Calls the backend generateProposal function. Returns the structured proposal
// letter, or throws — callers MUST fall back to buildProposalFallback so that
// sending the customer's paperwork is never blocked by an AI hiccup.
const proposalCallable = httpsCallable<
  { clerkToken: string; input: ProposalInput },
  ProposalLetter
>(functions, 'generateProposal', { timeout: 120000 })

interface ProposalInput {
  customerName: string
  jobTypeName: string
  workScope?: string
  customerSummary?: string
  total?: number
  depositRequested?: boolean
  depositAmount?: number
  proposedStartDate?: string
  jobLocationZip?: string
  businessName?: string
  contractorName?: string
  licenseNumber?: string
}

interface ProposalContext {
  businessName?: string
  contractorName?: string
  licenseNumber?: string
}

function inputFromEstimate(e: Estimate, ctx: ProposalContext): ProposalInput {
  return {
    customerName: e.customerName,
    jobTypeName: e.jobTypeName,
    workScope: e.aiQuote?.work_scope || e.scopeOfWork || '',
    customerSummary: e.aiQuote?.customer_summary || '',
    total: e.total,
    depositRequested: e.depositRequested,
    depositAmount: e.depositAmount,
    proposedStartDate: e.proposedStartDate,
    jobLocationZip: e.jobLocationZip,
    businessName: ctx.businessName || undefined,
    contractorName: ctx.contractorName || undefined,
    licenseNumber: ctx.licenseNumber || undefined,
  }
}

// Generate a proposal via the AI backend. Throws on failure (caller falls back).
export async function generateProposalLetter(
  clerkToken: string,
  e: Estimate,
  ctx: ProposalContext,
): Promise<ProposalLetter> {
  const res = await proposalCallable({ clerkToken, input: inputFromEstimate(e, ctx) })
  return res.data
}

// A clean, professional template proposal built with NO AI. Used as the
// guaranteed fallback when generation fails, so the customer always gets
// polished first paperwork and sending is never blocked.
export function buildProposalFallback(e: Estimate, ctx: ProposalContext): ProposalLetter {
  const first = (e.customerName || '').trim().split(/\s+/)[0] || 'there'
  const biz = ctx.businessName?.trim()
  const job = (e.jobTypeName || 'your project').replace(/^Quick Quote.*/i, 'your project')
  const scope = (e.aiQuote?.work_scope || e.scopeOfWork || '').trim()

  const startLine = e.proposedStartDate
    ? `We can begin around ${formatDate(e.proposedStartDate)}, and we'll confirm the exact schedule together before work starts.`
    : `We'll work out a start date together that fits your schedule, typically beginning within a week or two of acceptance.`

  const closingLines = [
    'We look forward to working with you,',
    ctx.contractorName?.trim() || '',
    biz || '',
    ctx.licenseNumber?.trim() ? `Lic. ${ctx.licenseNumber.trim()}` : '',
  ].filter(Boolean).join('\n')

  return {
    greeting: `Dear ${first},`,
    intro: biz
      ? `Thank you for the opportunity to bid ${job}. We at ${biz} are pleased to present this proposal outlining how we'll handle the work and what's included.`
      : `Thank you for the opportunity to bid ${job}. We're pleased to present this proposal outlining how we'll handle the work and what's included.`,
    approach: scope
      ? `Here's how we'll approach the work: we'll start by protecting your space, then complete the work described in the scope below in a careful, orderly sequence — from prep through to the finished result — keeping the site clean and keeping you informed along the way.`
      : `We approach every job with care, quality materials, and clear communication — protecting your space, doing the work right the first time, and cleaning up thoroughly when we're done.`,
    included: `This proposal includes:\n• All labor and materials detailed in the estimate below\n• Job-site cleanup and debris haul-away\n• Clear communication throughout the project`,
    not_included: `Not included:\n• Unforeseen structural, code, or hidden conditions discovered during the work\n• Any changes to the agreed scope, which would be quoted separately`,
    timeline: startLine,
    warranty: `We stand behind our work with a workmanship warranty. If anything isn't right, just reach out and we'll make it right.`,
    closing: closingLines,
  }
}

// Flatten a proposal letter into clean plain text (for print/PDF and sharing).
export function composeProposalText(p: ProposalLetter): string {
  return [
    p.greeting,
    '',
    p.intro,
    '',
    'OUR APPROACH',
    p.approach,
    '',
    p.included,
    '',
    p.not_included,
    '',
    'TIMELINE',
    p.timeline,
    '',
    'OUR GUARANTEE',
    p.warranty,
    '',
    p.closing,
  ].join('\n')
}

function formatDate(d: string): string {
  // Accept yyyy-mm-dd or ISO; fall back to the raw string if unparseable.
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d)
  if (isNaN(parsed.getTime())) return d
  return parsed.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}
