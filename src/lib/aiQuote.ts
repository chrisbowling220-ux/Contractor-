import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import type { AIQuote, Estimate, MaterialLine, RentalLine } from '../data/types'

export interface GenerateAIQuoteInput {
  customerName: string
  jobTypeName: string
  description: string
  jobLocationZip: string
  jobLocationRegion: string
  regionMultiplier: number
  rateType: 'flat' | 'hourly'
  hourlyRate?: number
  estimatedHours?: number
  flatAmount?: number
  laborTotal: number
  materials: MaterialLine[]
  rentals: RentalLine[]
  hourlyRateOverride?: number
  markupPercentOverride?: number
  debugForceFail?: string
}

// The Anthropic API key never reaches the browser. This client calls a Firebase
// Function (functions/src/index.ts) which holds the key in Firebase Secrets,
// verifies the caller's Clerk JWT, and proxies the Claude call. See README for
// the deploy + secrets-setup steps.
const callable = httpsCallable<
  { clerkToken: string; input: GenerateAIQuoteInput },
  AIQuote
>(functions, 'generateAIQuote')

export async function generateAIQuote(
  input: GenerateAIQuoteInput,
  clerkToken: string,
): Promise<AIQuote> {
  if (!clerkToken) {
    throw new Error('Not signed in — please sign in to generate quotes.')
  }
  try {
    const result = await callable({ clerkToken, input })
    return result.data
  } catch (err) {
    // Server already returns user-friendly messages for known failure modes
    // (overloaded, rate-limited, auth, 5xx). Pass through cleanly.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg)
  }
}

export function aiQuoteToScopeOfWork(
  q: AIQuote,
  customerName: string,
  jobTypeName: string,
): Estimate['scopeOfWork'] {
  return `SCOPE OF WORK — ${jobTypeName}

CLIENT: ${customerName}

SUMMARY:
${q.customer_summary}

${q.work_scope}`
}
