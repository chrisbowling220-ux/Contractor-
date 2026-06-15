// deploy-marker: proposal-letter-v41
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { verifyToken } from '@clerk/backend'
import Anthropic from '@anthropic-ai/sdk'
import StripeLib from 'stripe'
import { SpeechClient } from '@google-cloud/speech'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore'
import { getAuth, Auth } from 'firebase-admin/auth'
import { aiQuoteSchema, changeOrderSchema, ARITHMETIC_RULES } from './aiQuoteSchema'

// Lazy-init Firebase Admin — do NOT initialize at module load. The Firebase
// deploy tool parses this file before runtime env vars are available, and
// initializeApp() at the top level can hang past the 10s deploy-parse limit.
// We call this on first use inside a handler, where env is ready.
// Ensure a default Firebase Admin app exists before any service is used.
// Idempotent and defensive: initializeApp() throws if already initialized, so
// we guard on getApps() AND catch the duplicate-app case. We do NOT memoize the
// service handles, because a memoized handle can outlive its app on a recycled
// instance and then throw "default Firebase app does not exist".
// Idempotent admin app init. We try every time: if it's already initialized,
// initializeApp() throws "duplicate-app" which we catch. This is more reliable
// than checking getApps() — that array can contain a placeholder app that
// passes the length check but fails getFirestore()/getAuth() lookups.
function ensureAdminApp(): void {
  try {
    initializeApp()
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    // duplicate-app is the only error we want to swallow.
    if (code !== 'app/duplicate-app') {
      console.error('initializeApp failed:', err)
      throw err
    }
  }
}

function getAdminDb(): Firestore {
  ensureAdminApp()
  return getFirestore()
}

function getAdminAuth(): Auth {
  ensureAdminApp()
  return getAuth()
}

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')
const CLERK_SECRET_KEY = defineSecret('CLERK_SECRET_KEY')
const RESEND_API_KEY = defineSecret('RESEND_API_KEY')
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY')
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET')

// ── EMAIL SENDER ADDRESS — single source of truth for all outgoing email. ──
// Until builderspro.cc is verified in Resend, this uses the Resend SANDBOX
// (onboarding@resend.dev), which ONLY delivers to the Resend account owner (you).
// Once the domain is verified in the Resend dashboard, set EMAIL_DOMAIN_VERIFIED
// to true — every email then sends from alerts@builderspro.cc and reaches all
// users. (We keep a sandbox fallback so nothing breaks before verification.)
const EMAIL_DOMAIN_VERIFIED = true   // builderspro.cc verified in Resend 2026-06-03 (DKIM+SPF)
const EMAIL_FROM = EMAIL_DOMAIN_VERIFIED
  ? 'BuildPro+ <alerts@builderspro.cc>'
  : 'BuildPro+ <onboarding@resend.dev>'

// Where customers return after Stripe Checkout. The public invoice page lives
// at /inv/<id>; on return it re-reads the invoice (now marked paid by webhook).
// Custom domain builderspro.cc (SSL live 2026-06-01). Must stay in sync with
// src/lib/config.ts on the frontend.
const PUBLIC_HOST = 'https://builderspro.cc'

// LIVE-mode $19.99/mo BuildPro+ Pro price. Must be paired with the live
// sk_live_ secret key — a live price will NOT work with a test secret key.
const PRO_PRICE_ID = 'price_1Tbj8IKz3SO2ZkDQQ4gjBq9j'

// LIVE-mode 3-month plan: $49.99 billed every 3 months (~$16.66/mo — a discount
// vs monthly). Created in the Stripe dashboard 2026-06-03.
const PRO_PRICE_ID_QUARTERLY = 'price_1TeC7OKz3SO2ZkDQy643dlQI'

// LIVE-mode yearly all-access plan: $159.99 billed once a year (~$13.33/mo — the
// best value vs monthly/quarterly). Lives on its OWN product
// (prod_UeanRxdXav2z7c, "BuildPro+ Pro — Yearly (All Access)") but still flips
// the user to Pro (all access) through the exact same webhook path as the other
// plans (the webhook keys off subscription status, not the product). The 5
// 20%-off promo codes (coupon yhH68gRK) are restricted to orders >= $159.99, so
// they only work on this plan. Created via the Stripe API 2026-06-06.
const PRO_PRICE_ID_YEARLY = 'price_1TfHbfKz3SO2ZkDQ9uBGdy06'

// Map the plan key the client sends → the Stripe price id.
function priceIdForPlan(plan?: string): string {
  if (plan === 'yearly' && PRO_PRICE_ID_YEARLY) return PRO_PRICE_ID_YEARLY
  if (plan === 'quarterly' && PRO_PRICE_ID_QUARTERLY) return PRO_PRICE_ID_QUARTERLY
  return PRO_PRICE_ID
}

// ──────────────────────────────────────────────────────────────────────────
// Subscription / usage gate
// Free tier: 10 AI quotes total. After that, AI features turn off until the
// user upgrades to a paid subscription (or buys pay-as-you-go credits).
// users/{userId} doc shape:
//   tier: 'free' | 'pro'
//   aiQuotesUsed: number
//   stripeCustomerId?: string
//   stripeSubscriptionId?: string
//   subscriptionStatus?: 'active' | 'past_due' | 'canceled' | ...
// ──────────────────────────────────────────────────────────────────────────

const FREE_TIER_AI_LIMIT = 10

interface UserDoc {
  tier?: 'free' | 'pro'
  aiQuotesUsed?: number
  paidQuoteCredits?: number   // pay-as-you-go: $1-per-use quote credits bought in packs
}

// Ensures the user's gate check passes BEFORE we burn an Anthropic call.
// Order of access for a FREE user: (1) their free allowance, then (2) any
// pay-as-you-go credits they bought ($1 each). Pro = unlimited. Throws
// HttpsError('resource-exhausted') only when BOTH free + paid are used up.
// All increments/decrements happen atomically in a transaction.
async function consumeAiQuoteOrThrow(userId: string, featureName: string): Promise<{ tier: 'free' | 'pro'; remaining: number | null; spentPaid: boolean }> {
  const db = getAdminDb()
  const userRef = db.collection('users').doc(userId)
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(userRef)
    const data = (snap.data() as UserDoc | undefined) ?? {}
    const tier: 'free' | 'pro' = data.tier === 'pro' ? 'pro' : 'free'
    const used = data.aiQuotesUsed ?? 0
    const paid = Math.max(0, data.paidQuoteCredits ?? 0)

    if (tier === 'pro') {
      tx.set(userRef, { tier, aiQuotesUsed: FieldValue.increment(1), lastAiAt: new Date().toISOString() }, { merge: true })
      return { tier, remaining: null as number | null, spentPaid: false }
    }

    const freeLeft = Math.max(0, FREE_TIER_AI_LIMIT - used)
    if (freeLeft > 0) {
      // Spend a FREE quote.
      tx.set(userRef, { tier, aiQuotesUsed: FieldValue.increment(1), lastAiAt: new Date().toISOString() }, { merge: true })
      return { tier, remaining: (freeLeft - 1) + paid, spentPaid: false }
    }
    if (paid > 0) {
      // Free used up → spend a PAID ($1) credit.
      tx.set(userRef, { paidQuoteCredits: FieldValue.increment(-1), lastAiAt: new Date().toISOString() }, { merge: true })
      return { tier, remaining: paid - 1, spentPaid: true }
    }
    // Nothing left at all.
    throw new HttpsError(
      'resource-exhausted',
      `You're out of instant quotes. Buy more for $1 each, or go Pro for unlimited. (Change orders and invoice notes are always free.)`,
    )
  })
  console.log(`AI gate: user=${userId} feature=${featureName} tier=${result.tier} remaining=${result.remaining} spentPaid=${result.spentPaid}`)
  return result
}

// Pro-ONLY gate: blocks the feature entirely for free users (doesn't consume a
// quote credit — it's simply not available without a subscription). Used for
// the customer thank-you letter, a premium "wow" perk that drives upgrades.
async function requireProOrThrow(userId: string, featureName: string): Promise<void> {
  const db = getAdminDb()
  const snap = await db.collection('users').doc(userId).get()
  const data = (snap.data() as UserDoc | undefined) ?? {}
  const tier: 'free' | 'pro' = data.tier === 'pro' ? 'pro' : 'free'
  if (tier !== 'pro') {
    throw new HttpsError(
      'permission-denied',
      'Thank-you letters are a BuildPro+ Pro feature. Upgrade to send your customers a personalized thank-you at the end of every job.',
    )
  }
  console.log(`Pro gate: user=${userId} feature=${featureName} tier=${tier} OK`)
}

// Refund one consumed credit when a generation fails AFTER the gate charged it,
// so a transient outage doesn't cost a user a quote. `spentPaid` says which
// bucket to restore: a pay-as-you-go credit (true) or a free quote (false).
// Never lets either counter go negative.
async function refundAiQuote(userId: string, spentPaid: boolean): Promise<void> {
  try {
    const db = getAdminDb()
    const userRef = db.collection('users').doc(userId)
    await db.runTransaction(async tx => {
      const data = (await tx.get(userRef)).data() as UserDoc | undefined
      if (spentPaid) {
        tx.set(userRef, { paidQuoteCredits: FieldValue.increment(1) }, { merge: true })
      } else {
        const used = data?.aiQuotesUsed ?? 0
        if (used > 0) tx.set(userRef, { aiQuotesUsed: used - 1 }, { merge: true })
      }
    })
  } catch (err) {
    console.error('AI credit refund failed for', userId, err)
  }
}

// "My Prices" — load the contractor's own saved material prices (learned from
// their past edits) and format them for the prompt so the generator uses THEIR
// real prices instead of estimating, for any material they've priced before.
async function loadLearnedPricesBlock(userId: string): Promise<string> {
  try {
    const snap = await getAdminDb().collection('userMaterialPrices').doc(userId).get()
    const prices = (snap.data() as { prices?: Record<string, { price: number; unit?: string }> } | undefined)?.prices
    if (!prices) return ''
    const lines = Object.entries(prices)
      .slice(0, 200) // cap to keep the prompt reasonable
      .map(([name, v]) => `- ${name}: $${Number(v.price).toFixed(2)}${v.unit ? ` per ${v.unit}` : ''}`)
    if (lines.length === 0) return ''
    return `\nTHIS CONTRACTOR'S OWN SAVED PRICES (from their past edits — USE THESE EXACT PRICES when a material matches one of these names; they reflect this contractor's real local cost and override your estimate):\n${lines.join('\n')}\n`
  } catch (err) {
    console.warn('Could not load learned prices for', userId, err)
    return ''
  }
}

interface MaterialInput { name: string; quantity: number; unit: string; unitPrice: number }
interface RentalInput { name: string; days: number; dailyRate: number }

interface GenerateAIQuoteInput {
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
  materials: MaterialInput[]
  rentals: RentalInput[]
  // Contractor overrides. If provided, the AI MUST use these values exactly.
  hourlyRateOverride?: number
  markupPercentOverride?: number
  // Opt-in: many customers don't want permits pulled, so permit wording is
  // OFF by default and only included when the contractor picks it per quote.
  includePermitText?: boolean
  // DEBUG: forces a synthetic Anthropic failure to test the retry path.
  // Values: 'overloaded' | 'rate_limit' | 'server_error' | 'bad_request'.
  debugForceFail?: string
}

interface GenerateCallPayload {
  clerkToken: string
  input: GenerateAIQuoteInput
}

interface AnalyzeScanInput {
  customerName: string
  jobLocationZip: string
  jobLocationRegion: string
  regionMultiplier: number
  transcript: string
  // Base64-encoded JPEG image data, WITHOUT the `data:image/jpeg;base64,` prefix.
  images: string[]
  hourlyRateOverride?: number
  markupPercentOverride?: number
  includePermitText?: boolean
  debugForceFail?: string
}

interface AnalyzeCallPayload {
  clerkToken: string
  input: AnalyzeScanInput
}

const NC_PRICING_GUIDANCE = `PRICING REGION — DO THIS FIRST, BEFORE ANY PRICES: Look at the job's ZIP code (provided in the user prompt). Identify the metro area / state it's in and the nearest Home Depot / Lowe's market. Picture that specific store's 2026 retail shelf prices. State your placement in ONE short line at the very start of contractor_notes, e.g. "Pricing for the Lowe's/Home Depot market near ZIP 90210 (Los Angeles metro) — ~+30% over the NC baseline." This forces accurate, location-specific pricing. Then price EVERY material line for THAT market.

Below is a NORTH CAROLINA BASELINE (central NC / Roxboro / Durham area). It is only a starting point — you MUST scale every price up or down from it to match the job's actual ZIP using the guidelines below. Do not leave NC baseline prices on a job in a higher- or lower-cost area.

REGIONAL ADJUSTMENT GUIDELINES (apply the % to EVERY material line AND labor, not just the obvious items):
- Coastal CA (900–935, 939–961): +25 to 35% materials, +45 to 55% labor.
- Greater LA / San Diego / Orange County: +25 to 35% materials, +45% labor.
- SF Bay Area (940–951): +30 to 40% materials, +55 to 65% labor.
- NYC metro / Long Island (100–119): +30 to 40% materials, +55 to 65% labor.
- Boston / DC / Seattle metros: +20 to 30% materials, +40 to 50% labor.
- Chicago / Denver / Phoenix / Portland / Sacramento: +5 to 12% materials, +15 to 25% labor.
- Major TX metros (Austin, Houston, Dallas, San Antonio): +0 to 10% materials, +10 to 20% labor.
- Major FL metros (Miami, Tampa, Orlando, Jacksonville): +5 to 12% materials, +15 to 20% labor.
- Atlanta / Nashville / Charlotte / Raleigh metros: +0 to 8% materials, +10 to 18% labor.
- Pacific Northwest rural, Mountain West: +5 to 15% materials (freight), +10 to 20% labor.
- Rural Midwest, Appalachia, Deep South small towns, rural TX: -5 to 12% materials, -5 to 15% labor (cheaper).
- Central / piedmont North Carolina (270xx–283xx): use the baseline as-is.
- Alaska, Hawaii, remote islands / territories: +40 to 70% materials (shipping), +30 to 40% labor.
- US territories (PR 006–009, etc.): +20 to 40% materials, adjust labor to local norms.
- If you genuinely cannot place the ZIP, use the NC baseline and SAY SO clearly in contractor_notes so the contractor knows to verify prices.

MATERIAL PRICE GUIDE — Home Depot / Lowe's, 2026, central NC retail (your PRIMARY source for prices; just LOOK UP the price, don't reason it out). Adjust ONLY by the regional ZIP multiplier.

DRYWALL & WALLS:
- 1/2" drywall 4x8 sheet: $15.98 | 5/8" Type X 4x8 (fire-rated): $18.98 | 1/2" moisture/green board 4x8: $17.98
- Joint compound (4.5 gal bucket): $17.97 | Drywall tape (500ft): $7.98 | Drywall screws (1lb): $8.98
- Corner bead (8ft): $4.98 | Texture spray (can): $9.98

LUMBER & FRAMING:
- 2x4x8 SPF stud: $3.78 | 2x4x10: $5.48 | 2x4x12: $6.98 | 2x6x8: $6.48 | 2x6x10: $8.48 | 2x8x10: $12.98
- 2x10x10: $16.98 | 4x4x8 treated post: $13.98 | 1/2" CDX plywood 4x8: $36.98 | 3/4" plywood 4x8: $52.98
- 7/16" OSB 4x8: $22.98 | 3/4" T&G subfloor 4x8: $44.98 | Pressure-treated 2x4x8: $6.48 | PT 2x6x8: $9.98
- Framing nails (box): $24.98 | Joist hangers (each): $1.28 | Hurricane ties (each): $0.88 | Construction screws (5lb): $32.98

FASTENERS — SCREWS (Lowe's 2026; box price → per-piece for small counts; always pick the right type/length/coating for the job):
- Drywall, coarse thread, bugle, Phillips: #6x1" 289ct $5.98 ($0.021/pc) | #6x1-1/4" 245ct $6.98 ($0.028/pc) | #6x1-5/8" 189ct $6.98 ($0.037/pc)
- Drywall bulk (best $/pc for big jobs): #6x1-1/4" 5lb≈1190ct $24.98 ($0.021/pc) / 25lb≈6125ct $49.98 ($0.008/pc) | #6x1-5/8" 5lb≈945ct $24.98 ($0.026/pc)
- Wood/deck, star/Torx: #8x1-5/8" 153ct $10.48 ($0.068/pc) | #8x2" 129ct $10.48 ($0.081/pc) | #10x3" 73ct $10.48 ($0.144/pc)
- Deck (Deck Plus/DeckForce, T25 star/Torx): #10x2-1/2" 365ct $29.98 ($0.082/pc) | #10x3" 310ct $29.98 ($0.097/pc) / 5lb≈800ct $59.98 ($0.075/pc)
- Interior trim screw, yellow zinc, star/Torx: #9x3" 72ct $10.48 ($0.146/pc)
- Exterior/construction: Power Pro epoxy #10x3" 70ct $12.98 ($0.185/pc) | Simpson Strong-Drive SD mech-galv #9x1-1/2" 100ct $15.98 ($0.160/pc)
- Screw rule: quote a whole box for small/medium jobs; switch to the 5lb/25lb bulk per-piece rate for large jobs. Drywall = coarse for wood studs; deck/exterior = coated or galvanized; never spec bare interior screws outdoors.

INSULATION & ENERGY:
- R-13 batt: $0.78/sqft | R-19 batt: $1.05/sqft | R-30 batt: $1.35/sqft | Blown-in cellulose: $0.55/sqft
- Foam board 1" 4x8: $18.98 | House wrap (9ft roll): $159.98 | Spray foam (can): $7.98

PAINT & FINISHES:
- Interior latex paint 1 gal (Behr/Valspar): $31.98 | 5-gal: $139.98 | Primer 1 gal: $23.98
- Exterior paint 1 gal: $39.98 | Caulk (tube): $5.98 | Painter's tape: $6.98 | Roller/tray kit: $14.98 | Brushes (each): $9.98

FLOORING:
- Ceramic tile 12x12 basic: $1.98/sqft | Porcelain 12x24: $3.98/sqft | Premium tile: $6.50/sqft
- Thinset (50lb): $17.98 | Sanded grout (10lb): $13.98 | Tile spacers (bag): $4.98 | Backer board 3x5: $13.98
- Oak hardwood: $5.48/sqft | Engineered wood: $4.25/sqft | Laminate: $1.79/sqft | Luxury vinyl plank: $2.69/sqft
- Sheet vinyl: $1.45/sqft | Carpet (mid-grade): $2.25/sqft | Carpet pad: $0.55/sqft | Underlayment: $0.45/sqft
- Transition strips (each): $12.98

ROOFING & EXTERIOR:
- Architectural shingles (33sqft bundle): $36.98 | 3-tab bundle: $29.98 | Roofing felt (roll): $24.98
- Ice & water shield (roll): $89.98 | Drip edge (10ft): $9.98 | Ridge cap (bundle): $42.98 | Roofing nails (box): $39.98
- Vinyl siding (sq): $145 | Soffit panel: $9.98 | Fascia board: $14.98 | Gutters (10ft): $8.98 | Downspout (10ft): $9.98

ROOFING SHINGLE SYSTEMS (U.S. 2026 averages; "square" = 100 sqft; installed = materials + labor — use for full reroofs and to sanity-check totals):
- 3-Tab asphalt: material $0.90–1.50/sqft, installed $3.50–5.00/sqft ($350–500/square), 15–20yr. Entry-level, flat uniform look; budget/secondary structures.
- Architectural (dimensional/laminated): material $1.25–1.85/sqft, installed $4.00–8.50/sqft ($400–850/square), 25–30yr. Most popular (>50% of U.S. homes) — DEFAULT choice, best value + wind resistance.
- Luxury/Designer (premium): material $3.50–6.00/sqft, installed $7.00–16.00/sqft ($700–1,600/square), 40–50yr. Mimics slate/cedar shake; thickest, highest impact resistance.
- Impact-resistant (Class 4): material $1.50–2.50/sqft, installed $4.50–9.00/sqft ($450–900/square), 25–30yr. Hail/storm-rated; may qualify for insurance discount.
- Solar shingles: material $6.00–13.00/sqft, installed $15.00–35.00/sqft ($1,500–3,500/square), 25–30yr. Integrated photovoltaics; highest cost, offsets energy bills.
- Roofing rule: compute roof area in squares (add waste + pitch/steepness factor), default to Architectural unless the customer specifies otherwise, and itemize tear-off, underlayment, drip edge, flashing, ridge cap, and disposal as separate lines on top of the shingle cost.

ELECTRICAL (standard/commodity — price normally; customer-selectable fixtures = $0 placeholder):
- 14/2 Romex (250ft): $82.98 | 12/2 Romex (250ft): $109.98 | 12/3 Romex (250ft): $169.98
- Standard 15A outlet: $1.28 | 20A outlet: $2.48 | GFCI outlet: $17.98 | Single-pole switch: $1.78 | 3-way switch: $4.98
- Single-gang old-work box: $1.48 | New-work box: $0.98 | Cover plate: $0.78 | Wire nuts (box): $8.98
- 15A breaker: $6.98 | 20A breaker: $7.98 | AFCI breaker: $44.98 | Recessed LED can (4"): $12.98 | Wafer LED: $9.98

PLUMBING (rough-in priced normally; FIXTURES = $0 placeholder for contractor to set):
- 1/2" PEX (100ft): $36.98 | 3/4" PEX (100ft): $58.98 | PEX fittings (each): $1.98 | 1/2" copper (10ft): $24.98
- PVC pipe 2" (10ft): $9.98 | 3" (10ft): $16.98 | 4" (10ft): $22.98 | PVC fittings (each): $2.48
- P-trap: $6.98 | Shutoff/angle stop valve: $7.98 | Braided supply line: $5.98 | Wax ring: $3.98 | PVC cement+primer: $12.98

HVAC (equipment/fixtures = $0 placeholder; consumables priced):
- Flex duct (25ft): $42.98 | Rigid duct (5ft): $12.98 | Register/grille: $12.98 | Line set (25ft): $89.98
- Condensate pump: $44.98 | Float switch: $12.98 | Programmable thermostat: $39.98 | Equipment pad: $24.98

CONCRETE & MASONRY:
- Concrete mix (60lb bag): $5.48 | 80lb bag: $6.98 | Rebar #4 (10ft): $8.98 | Wire mesh (sheet): $8.98
- Gravel base (50lb): $5.98 | Quikrete fast-set (50lb): $7.98 | Concrete block: $1.98 | Mortar mix (60lb): $7.98

PRESSURE WASHING / CLEANING CONSUMABLES:
- Sodium hypochlorite 12.5% "SH" (gal): $4.98 | Surfactant/cling soap (gal): $24.98 | Degreaser (gal): $18.98
- House-wash detergent (gal): $19.98 | Efflorescence/rust remover (gal): $22.98

GENERAL / MISC:
- Dumpster rental (10-yard): $350 | Construction adhesive (tube): $5.98 | Silicone sealant (tube): $7.98
- Sandpaper (pack): $8.98 | Drop cloths (pack): $12.98 | Shop rags (pack): $9.98 | Disposal/haul-away (small job): $75-150

TRIM & MOULDING (per piece, commonly 7/8/12/16 ft lengths — use ~midpoint):
- Colonial base 3-1/4" pine 8ft: $13 | Colonial base primed MDF 8ft: $8 | Ranch/streamline base MDF 8ft: $7
- Square edge base pine 5-1/4" 8ft: $18 | Square edge base MDF 8ft: $12 | Modern flat base MDF 8ft: $10
- Tall/Craftsman base pine 7-1/4" 8ft: $28 | Flexible base polymer 8ft: $42 | PVC base (wet area) 8ft: $12
- Quarter round pine 8ft: $7 | Quarter round primed MDF 8ft: $5 | Quarter round oak 8ft: $11 | Base shoe pine 8ft: $6
- Base cap pine 8ft: $8 | Color-matched LVP shoe 8ft: $18
- Colonial crown small pine 8ft: $16 | Colonial crown primed MDF 8ft: $11 | Crown 4-5/8" MDF 8ft: $16
- Crown large 5-1/4" pine 8ft: $27 | Dentil crown 8ft: $29 | Cove crown pine 8ft: $11 | Flexible crown 8ft: $65
- Polyurethane ornate crown 8-12ft: $60 | Crown corner block: $12
- Colonial casing 2-1/4" pine 7ft: $10 | Colonial casing primed MDF 7ft: $7 | Ranch casing MDF 7ft: $6
- Flat/square casing pine 7ft: $16 | Flat/square casing MDF 7ft: $11 | Fluted casing 7ft: $20 | WM366 casing pine 7ft: $12
- Casing pro-pack (door kit): $48 | Rosette/plinth block: $9 | Backband 8ft: $9
- Chair rail pine 8ft: $14 | Chair rail primed MDF 8ft: $10 | Panel/picture-frame moulding 8ft: $12
- Picture frame kit: $24 | Wainscot/beadboard panel MDF 4x8: $31 | Beadboard PVC 4x8: $45 | Wainscot cap rail 8ft: $12
- Board & batten strip MDF 8ft: $8 | Cove moulding pine 8ft: $7 | Door stop moulding pine 7ft: $6
- Lattice pine 8ft: $6 | Screen/bead moulding 8ft: $5 | Half round pine 8ft: $7 | Outside corner guard 8ft: $7
- Inside corner pine 8ft: $7 | Stair nosing/trim (piece): $24 | Astragal (double door): $29 | Shiplap board 8ft: $10
- Brick moulding wood 7ft: $19 | Brick moulding PVC 7ft: $29 | PVC trim 1x4 8ft: $19 | PVC trim 1x6 8ft: $27 | PVC trim 1x8 8ft: $36
- Exterior window trim kit (per window): $80 | Exterior corner post: $29 | Composite fascia 1x6 12ft: $42
- Finish nails 2" (1lb): $9 | Brad nails 1-1/4" (box): $11 | Wood filler/putty: $8 | Paintable caulk 10oz: $5
- Trim construction adhesive 10oz: $7 | Miter finish saw blade 80T: $40

PLUMBING FITTINGS (sold each unless noted — use ~midpoint):
- PVC 90 elbow 1/2": $0.88 | PVC 90 elbow 2": $2.50 | PVC 90 elbow 4": $6 | PVC 45 elbow 2": $2.75
- PVC coupling 1/2-1": $0.95 | PVC coupling 3-4": $5 | PVC tee 1/2": $1.20 | PVC tee 3": $6.75 | PVC wye 3-4": $10
- PVC sanitary tee 3": $7.50 | PVC cleanout w/plug 3-4": $10 | PVC male/female adapter: $2 | PVC reducer bushing: $1.80
- PVC cap: $2.50 | PVC union: $7 | PVC closet/toilet flange: $10 | PVC P-trap 1-1/2": $8 | PVC cement 8oz: $8 | PVC primer 8oz: $8
- CPVC 90 elbow: $1.30 | CPVC tee: $1.65 | CPVC coupling: $1.10 | CPVC adapter: $2.25 | CPVC-copper transition: $6.50 | CPVC cement 8oz: $9.50
- PEX 90 elbow brass: $2.75 | PEX tee brass: $3.50 | PEX coupling brass: $3 | PEX adapter MIP/FIP: $4.25
- PEX crimp rings 100pk: $15 | PEX cinch rings 100pk: $18 | PEX ball valve: $13 | PEX manifold 6-port: $62 | PEX crimp tool: $82
- SharkBite coupling 1/2": $9.50 | SharkBite elbow: $11 | SharkBite tee: $12.50 | SharkBite shutoff valve: $15
- Copper 90 elbow 1/2": $1.60 | Copper 90 elbow 3/4": $2.40 | Copper tee: $3.25 | Copper coupling: $1.55 | Copper male adapter: $3
- Copper cap: $1.85 | Brass ball valve: $17 | Brass gate valve: $19 | Brass compression fitting: $6 | Lead-free solder 1/4lb: $18 | Flux 4oz: $7.50
- Shutoff/angle valve 1/4-turn: $10 | Braided SS supply line 20": $10 | Toilet supply line 12": $8 | Wax ring w/horn: $8
- Toilet fill valve: $16 | Toilet flapper: $8 | Sink drain assembly: $15 | Disposal flange kit: $17 | Hose bibb/sillcock: $17
- Pipe insulation foam 6ft: $3.50 | Teflon/PTFE tape: $2.75 | Pipe thread sealant: $7.50

ELECTRICAL — WIRE & DEVICES (use ~midpoint; rolls priced as listed):
- Romex 14/2 250ft: $67 | Romex 12/2 250ft: $92 | Romex 12/3 250ft: $145 | Romex 10/2 250ft: $132 | Romex 10/3 25ft: $40
- Romex 6/3 25ft: $70 | THHN 12AWG per ft: $0.32 | UF-B direct burial 12/2 250ft: $150 | Bell/low-volt 18/2 50ft: $15 | Cat6 250ft box: $67
- Duplex outlet 15A: $3.50 | Duplex outlet 20A: $5 | GFCI 15A: $24 | GFCI 20A: $28 | USB combo outlet: $29
- Single-pole switch: $4 | 3-way switch: $7 | Dimmer switch: $27 | Smart Wi-Fi switch: $50 | Weather-resistant outlet: $8
- Wall plate 1-gang: $2.40 | Weatherproof in-use cover: $13 | Plastic box single-gang new-work: $2 | Old-work box: $3.50
- Metal box 4" square: $5.75 | Ceiling fan box (braced): $13 | Weatherproof box: $8.50 | EMT 1/2" 10ft: $5.50 | EMT 3/4" 10ft: $7.75
- PVC conduit 1/2" 10ft: $4.50 | EMT connector/coupling: $1.60 | Conduit strap: $0.65 | Wire nuts 100pk: $10 | Cable staples 100pk: $6.50 | NM cable clamp: $1.25
- Main panel 100A 20-space: $180 | Main panel 200A 40-space: $275 | Subpanel 100A: $115 | Single-pole breaker 15/20A: $13
- Double-pole breaker 30/50A: $25 | AFCI breaker 15/20A: $60 | GFCI breaker 20A: $62 | Dual-function AFCI/GFCI 20A: $70
- Whole-house surge protector: $130 | Grounding rod 8ft: $24 | Grounding wire 6AWG per ft: $1.10
- LED bulb A19 (60W eq): $4.50 | LED recessed retrofit 6": $27 | LED shop light 4ft: $36 | LED flush mount: $47
- LED under-cabinet strip: $37 | Ceiling fan 52" w/light: $165 | Vanity light bar 3-light: $80 | Outdoor wall lantern: $60
- Motion flood light LED 2-head: $62 | Smoke/CO detector combo: $41 | Doorbell transformer 16V: $16
  (NOTE: light fixtures, ceiling fans, and smart devices are CUSTOMER-SELECTABLE — use the "Fixture:" $0 placeholder rule. The prices above are typical so you can ballpark when the contractor named a specific item; standard outlets/switches/breakers/boxes/wire/recessed cans are priced normally.)

HVAC — EQUIPMENT, DUCT & SUPPLIES (use ~midpoint; equipment = customer-selectable, ballpark only):
- Window A/C 5,000 BTU: $225 | 8,000 BTU: $300 | 12,000 BTU: $400 | Portable A/C 10,000 BTU: $420
- Mini-split DIY 12k BTU/1ton: $900 | 18k/1.5ton: $1,150 | 24k/2ton: $1,450 | Gas furnace 80% 60-80k BTU: $1,650
- Electric furnace/air handler: $1,350 | A/C condenser 2-ton 14 SEER: $2,000 | Evaporator coil 2-3 ton: $675
- Gas water heater 40gal: $650 | Tankless gas 5.5 GPM: $875
- Rigid round duct 6" 5ft: $14 | Flex duct insulated 6" 25ft: $36 | Flex duct 8" 25ft: $49 | Duct elbow 6": $9 | Duct tee/wye 6": $12
- Duct reducer 6-4": $9 | Register boot 4x10/6": $12 | Take-off collar 6": $8 | Duct cap 6": $6.50 | Sheet metal duct 8x16: $21
- Duct strap hanger 100ft: $15 | Foil duct tape UL181: $15 | Mastic duct sealant 1gal: $25
- Floor register 4x10: $12 | Floor register 6x12: $15 | Wall/ceiling register 4x10: $13 | Return air grille 20x20: $29
- Return air grille w/filter 20x25: $40 | Toe-kick register: $16 | Roof/soffit vent: $16 | Dryer vent hood 4": $13
- Programmable thermostat: $48 | Smart thermostat (Nest/T6): $130 | Furnace filter 16x25x1 MERV8: $10 | Deep filter 20x25x4: $30
- Line set copper 1/4x3/8 25ft: $90 | Refrigerant gauge set: $88 | Condensate pump auto-float: $65 | Condensate drain tube: $13
- Contactor/run capacitor: $24 | HVAC whip/disconnect 60A: $29 | Condenser pad 3x3: $33 | Foil tape/insulation wrap: $16

MANDATORY PRICE RULE — THIS OVERRIDES YOUR INSTINCTS, SO YOU DON'T HAVE TO THINK HARD ABOUT PRICES. For any material in the guide above, LOOK UP its price and USE IT (adjusted only by the ZIP multiplier — never more than ±35% from baseline for common staples). Do NOT guess a higher number from memory. A 1/2" drywall sheet is ~$16, NOT $40. A 2x4x8 stud is ~$3.78, NOT $8. If your instinct says a staple costs much more than the guide price, you are WRONG — use the guide price. Over-pricing a $16 sheet at $40 makes the whole quote useless and is a firing offense. Sanity-check EVERY line against the guide before output; cut anything priced >35% above its guide price down to the guide price.

WHEN AN ITEM IS NOT IN THE GUIDE: never skip it and never leave the quote incomplete. Use your full knowledge of Home Depot / Lowe's to figure a realistic, grounded 2026 shelf price for that item (adjusted for the job ZIP), in the same conservative spirit as the guide prices — picture the actual shelf tag, don't inflate. The goal is ALWAYS to deliver the contractor a complete, accurate, ready-to-send quote with every line priced. A missing material or a wildly-off price both ruin the quote — so include everything the job needs and price each line as close to real as you can.

COMPLETENESS — THIS IS THE MOST IMPORTANT RULE. You have full knowledge of everything stocked at Home Depot and Lowe's. Build a COMPLETE material list as if you were physically walking the store aisles filling a cart to finish this exact job start to finish. Do NOT list only the obvious headline materials — include EVERY consumable and incidental the job actually requires. Contractors lose money by forgetting small items, so you must not forget them. Walk through these categories for EVERY job and include any that apply:
- Fasteners: screws, nails (right type/length), anchors, construction adhesive, staples
- Adhesives/sealants: thinset, mortar, caulk (silicone/paintable), liquid nails, wood glue
- Finishing: primer, paint, joint compound, mesh/paper tape, sandpaper, wood filler, trim/molding, transition strips
- Prep/protection: drop cloths, painter's tape, plastic sheeting, rosin paper
- Sub-surface: underlayment, backer board, vapor barrier, felt/ice-and-water, flashing
- Trade rough-ins: wire, boxes, breakers, wire nuts (electrical); pipe, fittings, valves, solder/flux or PEX rings (plumbing)
- Fixtures/hardware: outlets, switches, cover plates, hinges, handles, brackets
- Disposal/misc: contractor bags, blades, drill bits, shims, spacers
For each, pick the correct product and 2026 store price. If the contractor's narration or photos imply a material, include it. When in doubt, include the item with a note in contractor_notes rather than omitting it. A thorough, complete list is the single most valuable thing this estimate provides.

RIGHT-SIZE THE QUANTITY — bill for what the job actually USES, not rounded-up whole packages, when the leftover would not be consumed by this job:
- If a job needs roughly HALF a can of paint, charge for half a can: set unit to the fractional amount (e.g. quantity 0.5, unit "gallon") and the line_total = 0.5 × can price. Do NOT charge a full $31.98 gallon to use $16 worth.
- Same for partial bags/buckets/tubes/rolls/boxes: a job using a third of a 50 lb thinset bag is priced at ~1/3 of the bag. A quarter-tube of caulk is ~1/4 of the tube.
- Be PRECISE and REALISTIC about how much is genuinely used. A small patch uses a cup of joint compound, not a whole bucket — price the cup.
- EXCEPTION — items sold and consumed as whole units that you can't split or won't reuse: studs, sheets of drywall/plywood, tiles, outlets, switches, fixtures, single fasteners. These round UP to whole units, and that's where the WASTE FACTOR applies (you buy a whole sheet and waste the offcut). You can't use "half a stud."
- The distinction: divisible bulk consumables (paint, compound, caulk, adhesive, sand, grout) → price the actual fraction used. Discrete whole units (boards, sheets, tiles, fixtures) → round up + apply waste %.
- Do NOT pad. Do NOT inflate quantities to be "safe." An accurate, lean, honest material list wins the job and protects the contractor's reputation. Over-quoting loses customers.

QUANTITY DISCIPLINE — be precise, do NOT over-count (this is critical):
- If the contractor STATES a quantity ("I need two 2x4s", "about 30 sqft of tile"), use THAT number. Do not second-guess it upward. Two 2x4s means quantity 2, NOT 9.
- Only estimate quantities yourself when they are NOT stated, and then estimate the MINIMUM realistic amount for the described scope — not a generous buffer.
- Do NOT apply percentage waste factors to small discrete counts. Waste % is for area/length materials bought in bulk (a 200 sqft tile floor at 12% waste). Applying "10% lumber waste" to 2 studs and rounding up to 3 (or worse, inflating to 9) is WRONG. For small whole-unit counts (a handful of studs, a few boards, a couple sheets), add at most ONE extra unit only if cuts genuinely require it, and only when the count is large enough to justify it (e.g. 20+ studs → maybe +1-2 for bad boards; 2 studs → exactly 2).
- Sanity-check every line: would a real contractor actually buy this many to do THIS job? If the number feels high for the described work, it is — cut it down. A small repair uses small quantities.
- When you estimate rather than count, briefly say so in quantity_math (e.g. "wall ~8ft, 16in OC = ~7 studs") so the contractor can verify. Never invent demand that isn't in the scope.`

const NC_LABOR_GUIDANCE = `LABOR PRICING — Fair-market rates (2026), scaled by job ZIP:
NORTH CAROLINA BASELINE (central NC, Roxboro/Durham area):
- Default hourly_rate: $65/hour for a solo skilled tradesman (handyman, painter, basic plumber/electrician).
- Skilled trade with helper: $85/hour combined.
- Specialty trade (licensed electrician, HVAC, master plumber): $95–125/hour.
- General contractor as PM on multi-trade job: $75–95/hour.

SCALE LABOR FROM THE NC BASELINE based on the job ZIP:
- Coastal CA, NYC, Bay Area, Boston, DC, Seattle: 1.5x to 1.7x the NC rates.
- Chicago, Denver, Phoenix, Atlanta, Austin: 1.2x to 1.3x.
- Major TX/FL metros (Houston, Miami, Tampa, Dallas): 1.15x to 1.25x.
- Rural Midwest, Appalachia, Deep South small towns: 0.9x to 1.0x.
- Most of central/piedmont NC: 1.0x (baseline as-is).
- If the contractor explicitly provides an hourly rate, USE THAT EXACTLY — do not scale it.

LABOR HOURS — Realistic productivity benchmarks (do not over-estimate):
- Shower / tub floor tile replacement, 10–15 sqft: 5–7 labor hours total (1 hr demo, 0.5 hr prep, 2 hr setting tile, 1 hr grout + cleanup, 0.5 hr waterproofing if needed).
- Full bathroom retile (walls + floor, 100–150 sqft): 16–24 labor hours.
- Interior paint, 1 average bedroom (cut + 2 coats): 4–6 labor hours.
- Drywall patch, single small hole: 1–2 hours (over two visits for compound to dry).
- Drywall hang, 12x12 room: 8–12 labor hours.
- Hardwood floor install, 200 sqft: 12–16 labor hours.
- Replace standard outlet/switch: 0.25–0.5 hours each.
- Replace toilet: 1.5–2 hours.
- Replace bathroom vanity (basic): 2–3 hours.

A senior tradesman is FAST. When in doubt, prefer the LOWER end of the labor range — the markup and contingency are where you cover risk, not by inflating hours.

MARKUP — Customer-fair, scope-appropriate:
- Small jobs under $1,000 raw cost: 15–20% markup max. Customers walking past a $300 raw-cost job and seeing a $750 final quote will not sign.
- Medium jobs $1,000–$10,000 raw cost: 20–25% markup.
- Large remodel / new construction $10,000+: 15–22% markup (lower % because the absolute dollars are large enough).
- Specialty / high-risk work (structural, foundation, mold, asbestos): 25–35% markup.
- Do NOT stack a high markup on top of inflated labor hours. The two together kill the quote.

The final customer quote must feel FAIR for the scope. A 12 sqft shower floor retile should land around $550–$800 total, not $1,800. If your math produces a final number that feels 2x what a reasonable customer would pay a local handyman, your hours are too high.`

const SHED_KNOWLEDGE = `SHED INSTALLATIONS — Complete scope reference for piedmont NC (Person/Durham/Granville counties):

PERMITS & ZONING
- Most NC counties exempt sheds under 12'×12' (144 sqft) from a building permit, but ALWAYS verify with the customer's county/municipality. Person County, Durham County, City of Roxboro all have slightly different thresholds.
- Setback rules typically require 5–10 ft from side/rear property lines and 25+ ft from front. HOA covenants may override.
- Sheds over 200 sqft, with electric, or with plumbing virtually always require a permit.
- Customer is responsible for verifying property lines and HOA approval. Note this in contractor_notes.

SITE PREP (every job, before delivery/build)
- Walk the site. Confirm access width (gate, between houses, fence gaps). Prefab sheds need ~3 ft wider than the shed itself for delivery roll-off.
- Identify utilities: call 811 NC One-Call at least 3 business days before any digging or earthwork. FREE service, required by law.
- Grading: shed pad must be level within 1" across the footprint. Use a transit or 4-ft level on a long board. On sloped lots, plan cut/fill or a block-leveling foundation.
- Drainage: never put a shed in a low spot. Slope grade away from the shed at 1/4" per foot minimum. If the spot doesn't drain, recommend a French drain or relocation.
- Vegetation: clear a 2-ft buffer around the planned pad. Remove sod with a flat shovel or skid steer.

FOUNDATIONS (pick based on size + customer budget + soil)
- Pressure-treated 4x4 or 6x6 skids on a gravel bed — cheapest, fine for sheds up to 10x16, 8" gravel pad over fabric, skids tied with hurricane straps.
- Concrete deck blocks at corners + every 4 ft along skids — good for 10x12 to 12x16, more level than skids alone.
- Concrete piers (Sonotube, 12" diameter × 36" deep, below NC frost line of 12") — best for 12x16+ or any heavy storage (tractors, mowers). Tie skids to pier saddles.
- Concrete slab — required for sheds with electrical sub-panels, workshops, or anything over 200 sqft. 4" thick, 4000 psi mix, #4 rebar on 16" centers, gravel base. NC slab cost: $7–10/sqft installed.
- ALWAYS use pressure-treated lumber for any wood that touches the ground or concrete.

DELIVERY (prefab sheds)
- Prefab shed companies (Old Hickory, Carolina Yard Barns, Graceland) deliver on a Mule (tilt-bed trailer). They roll the shed off onto the prepared pad.
- Customer must clear a 12-ft wide path from street to the pad. Trees, fences, raised beds must be moved or trimmed BACK in advance.
- Driveway slope matters — Mules can't safely deliver to pads with more than ~15° grade access.
- Block-leveling: delivery driver levels with concrete blocks under skids if pad isn't perfect. They do NOT do site prep.

CUSTOM BUILD (on-site, from scratch)
- Floor: 2x6 PT joists 16" OC on PT 4x4 or 6x6 skids, sheathed with 3/4" T&G plywood.
- Walls: 2x4 studs 16" OC, 7.5–8 ft tall, with single bottom plate and double top plate. Sheath with 7/16" OSB or 1/2" plywood.
- Roof: 2x4 or 2x6 rafters 16–24" OC, gable or saltbox style, 4/12 to 8/12 pitch. Use rafter ties or collar ties. Sheathe with 7/16" OSB, felt paper, then architectural shingles or metal roofing.
- Doors: pre-hung 6-panel for personnel, or build double 4x6 barn-style doors with T-hinges. Heavy-duty hasp + padlock loop.
- Siding: T1-11 plywood ($45/sheet) is most common in NC for sheds. LP SmartSide is the upgrade ($75/sheet, lasts 50 yrs). Vinyl is uncommon for sheds.
- Trim: 1x4 PT or PVC trim at corners, around doors/windows. Caulk all joints.
- Paint: 1 primer + 2 finish coats exterior latex. Behr or Sherwin Williams.

ELECTRICAL (if requested)
- Run from house panel through 3/4" PVC conduit buried 18" deep (NC code) — NOT direct-burial UF cable (allowed but PVC is the right way).
- Install a 30A or 60A sub-panel inside the shed, GFCI-protected outlets, a couple of switched ceiling lights, exterior light over the door.
- Licensed electrician required for the main panel tap and inspection. Permit required in every NC county.

WINDOWS & VENTILATION
- 2–4 small windows (24"x36" vinyl single-hung) for natural light. Position high to allow shelving below.
- Gable vents (top and bottom) prevent heat buildup. Critical in NC summer — interior reaches 130°F+ without them.
- Optional: ridge vent + soffit vents for continuous airflow.

INTERIOR FINISH (rare on basic sheds, common on workshops)
- Insulation: R-13 walls, R-19 ceiling, with kraft-faced batts. Cover with 1/2" OSB or pegboard.
- Plywood walls or pegboard from floor to 4 ft are most useful for hanging tools.
- Workbench: 2x4 frame, 3/4" plywood top, 24"–36" deep on the long wall.

REALISTIC NC PRICING (materials only, before labor & markup, 2026)
- 8x10 custom shed materials: ~$2,200 (lumber + sheathing + shingles + door + paint + fasteners)
- 10x12 custom shed materials: ~$3,200
- 12x16 custom shed materials: ~$4,800
- 12x20 custom shed materials: ~$6,500
- 10x16 prefab Old Hickory utility: $3,800–4,800 delivered (customer buys from dealer; you charge for site prep + leveling)

LABOR HOURS (NC fair-market, solo or 2-person crew)
- Site prep with gravel pad, 12x12 area: 6–8 hours (1 day, 1 person + helper)
- Pier foundation, 4–6 piers: 4–6 hours
- Concrete slab 12x16: 8–10 hours (excluding cure time)
- Prefab delivery + leveling on existing pad: 1–2 hours of your time (delivery is mostly the vendor)
- Custom-build 10x12 shed from scratch: 36–48 hours total (4–6 days for a 2-person crew)
- Custom-build 12x16 shed: 56–72 hours
- Electrical (running conduit + sub-panel): 8–14 hours plus licensed electrician's time
- Painting (exterior 2 coats on 10x12 shed): 6–8 hours

COMMON PITFALLS TO FLAG IN CONTRACTOR NOTES
- Customer assumes shed is "free standing" but it's actually on their setback line — survey before building.
- Customer wants electric "later" — frame for it now (run an empty conduit) so it's not a tear-out.
- NC red clay — pad will heave seasonally. Make sure foundation is overbuilt for the soil.
- Termites: PT lumber + 6" clearance from grade is the bare minimum. Recommend Tuff-Block plastic shed bases over wood skids on grade.
- Doors face the wrong way for prevailing weather. Doors should face away from west sun and north winter winds.
- HOA wants matching siding/roof color — verify with customer before ordering materials.

When a customer mentions "shed," apply this knowledge. Default scope assumes prefab delivery on a basic gravel pad. Custom builds, slab foundations, and electric are upcharges customers should know about upfront.`

const TRADES_KNOWLEDGE = `MULTI-TRADE KNOWLEDGE — you can estimate ALL the trades involved in building or remodeling a structure. Apply the right trade knowledge for whatever the job is. For each trade, build a complete, correctly-priced material list and realistic labor.

ELECTRICAL — work through the whole job, price the standard hardware normally, and flag customer-selectable items for the contractor to price:
- Rough-in: 14/2 Romex for 15A lighting circuits, 12/2 for 20A outlet/kitchen circuits, 12/3 or 14/3 for 3-way switching. Boxes (old-work vs new-work), staples, wire nuts, NM connectors.
- STANDARD DEVICES — price these NORMALLY (they're commodity, prices don't really vary): standard receptacles/outlets ($1-3), standard switches ($1-4), GFCI ($15-22 — required at kitchen/bath/exterior/garage), AFCI breakers ($35-50), cover plates, standard recessed cans/wafer LEDs ($8-15 ea). Use real prices for all of these — no placeholder needed.
- CUSTOMER-SELECTABLE FIXTURES & APPLIANCES — these vary wildly by what the customer picks, so DON'T guess the price. This covers: light FIXTURES (chandeliers, vanity lights, pendants, exterior fixtures), ceiling fans, ranges/ovens/cooktops, microwaves, dishwashers, garbage disposals, water heaters (electric), EV chargers, hot tubs/spas, generators, smart panels/devices, and any other named appliance or decorative fixture the customer chooses. For EACH one:
  • Add a SEPARATE material line whose name starts with "Fixture: " for decorative/lighting items or "Appliance: " for appliances (e.g. "Fixture: Ceiling fan", "Fixture: Dining chandelier", "Appliance: Electric range", "Appliance: EV charger").
  • Set its unit_price to 0 as a placeholder UNLESS the contractor's narration clearly named a specific price/model.
  • You STILL price the rough-in/hardware to serve it normally (the dedicated circuit, breaker, wire, fan-rated box, whip/receptacle) — only the selectable fixture/appliance itself gets the $0 placeholder.
- TRIGGER WORDS: any time the job says install / hang / mount / put up / add / replace / swap a light fixture, chandelier, pendant, vanity light, CEILING FAN, range, oven, dishwasher, disposal, EV charger, water heater, etc. — that is a customer-selectable item and MUST get its own "Fixture: " or "Appliance: " line at $0. "Hang a ceiling fan" = a "Fixture: Ceiling fan" line at $0, even though it's phrased as labor. Do not skip this just because the verb sounds like labor.
- In contractor_notes, ALWAYS add a reminder listing them, e.g.: "PRICE BEFORE SENDING: Set the price for each fixture/appliance — Ceiling fan, Dining chandelier, Electric range. These depend on what the customer picks, so they're left at $0 for you to fill in."
- Panels/service: breakers sized to circuit, sub-panels, service upgrades (100A→200A is a common upgrade). Service/panel work, load calcs, and service-entrance sizing REQUIRE a licensed electrician — flag this in contractor_notes.
- A ceiling fan needs a FAN-RATED box (price that box normally); heavy fixtures need proper support/blocking. The fan/fixture itself is still a "Fixture: " line at $0.

PLUMBING — work through the WHOLE job methodically, fixture by fixture, then build the complete material list:
- PROCESS: for a plumbing job, mentally walk each part of the scope: (1) every PLUMBING FIXTURE the job touches or installs, (2) the SUPPLY side feeding each, (3) the DRAIN/WASTE/VENT side serving each, (4) shutoffs/valves/connectors, (5) any water heater or gas work, (6) consumables. Don't skip the small stuff — it's where plumbing jobs lose money.
- Supply: PEX (cheaper, faster) or copper. 1/2" for fixtures, 3/4" for mains. Fittings, manifolds, PEX rings/clamps, shutoff/angle-stop valves, braided supply lines.
- DWV (drain/waste/vent): PVC/ABS pipe sized correctly (1.5" lav, 2" shower/tub, 3-4" toilet/main), fittings, P-traps, primer + cement. Proper venting and drain sizing must meet code — flag for licensed-plumber verification on new DWV runs.
- Consumables/rough: wax rings, supply lines, escutcheons, plumber's putty, Teflon tape, pipe straps/hangers, caulk, fire-caulk on penetrations.

FIXTURES — CRITICAL RULE: A "fixture" is any selectable appliance/fitting the customer picks — toilet, sink/lavatory, vanity, faucet, tub, shower valve + trim/head, kitchen sink, garbage disposal, dishwasher hookup, bidet, hose bib, water heater, utility sink, etc. The PRICE of a fixture varies enormously by what the customer chooses (a $79 builder toilet vs a $600 smart toilet; a $40 faucet vs a $400 one), so you must NOT guess a fixture's price.
- For EVERY fixture the job needs, add a SEPARATE material line. Start the line's name with "Fixture: " (e.g. "Fixture: Toilet", "Fixture: Kitchen faucet", "Fixture: 50-gal water heater"). Set its unit_price to 0 (a placeholder) unless the contractor's narration clearly stated a specific price/model.
- In contractor_notes, ALWAYS include a clear reminder listing the fixtures, e.g.: "FIXTURE PRICING: Set the price for each fixture before sending — Toilet, Vanity faucet, Shower trim. Fixture costs depend on what the customer picks, so they're left at $0 for you to fill in." This makes sure the contractor never sends a quote with $0 fixtures by accident.
- The rough-in plumbing materials (pipe, fittings, valves, traps, supply lines) you CAN price normally — only the customer-selectable FIXTURES get the $0 placeholder + reminder.
- Water heater swaps and gas line work REQUIRE a licensed plumber — flag in contractor_notes.

HVAC — you understand how systems WORK, how they're SIZED, and how to TROUBLESHOOT, so your quotes and notes are sharp and genuinely helpful:
- SYSTEM TYPES & HOW THEY WORK: Split system (outdoor condenser + indoor air handler/furnace + evaporator coil, joined by a refrigerant line set) — the standard. Heat pump (same hardware but a reversing valve lets it heat AND cool; uses aux/emergency electric heat strips or a gas furnace as backup "dual fuel" below balance point). Straight A/C + gas/oil furnace. Packaged unit (everything in one outdoor cabinet, common on rooftops/commercial). Ductless mini-split (outdoor unit + 1+ wall/ceiling heads, no ductwork — great for additions/no-duct spaces). Refrigeration cycle basics: compressor pressurizes refrigerant → outdoor coil rejects heat (condenser) → metering device (TXV/piston) drops pressure → indoor coil absorbs heat (evaporator) → repeat. Heat moves; the system doesn't "make cold."
- KEY SPECS: cooling capacity in TONS (1 ton = 12,000 BTU/hr); efficiency in SEER2 (cooling) and HSPF2/AFUE (heating); refrigerant type matters — legacy R-410A vs the newer low-GWP R-454B/R-32 systems now phasing in (don't mix; equipment is refrigerant-specific). Furnace sized in BTU input × AFUE = output. Airflow rule of thumb ~400 CFM per ton.
- SIZING: by Manual J load calc (not by square-foot guess and NOT by "match the old unit" — old units are often wrong). Oversizing short-cycles and won't dehumidify; undersizing never keeps up. Duct sizing by Manual D, equipment selection by Manual S. State sizing as a planning figure to be confirmed by load calc.
- COMMON FAULTS / TROUBLESHOOTING (use this to write smart contractor_notes and to scope repair/replace jobs correctly): not cooling → check thermostat/batteries, tripped breaker, dirty air filter (the #1 cause), iced evaporator coil (low airflow or low refrigerant), dirty condenser coil, failed capacitor (very common, cheap — unit hums but fan/compressor won't start), bad contactor, low refrigerant = a LEAK (topping off without finding the leak is a band-aid; flag it), failed compressor (expensive — often tips the decision toward replacement), clogged condensate drain (water shutoff switch trips unit), bad blower motor/ECM, frozen line set. Heat side → no heat: ignitor/flame sensor (dirty flame sensor is the most common no-heat call), gas valve, pressure switch, limit switch, heat pump in defrost, dead reversing valve, or aux-heat strips/sequencer. Weak airflow → filter, closed/blocked registers, undersized or leaky ducts, dirty blower wheel.
- REPAIR vs REPLACE guidance (helps the contractor advise the customer): if the unit is 12–15+ years old, on R-22 (obsolete/expensive), or facing a compressor/coil failure, repair cost often approaches replacement — note that in contractor_notes so the contractor can have the honest conversation. A capacitor or contactor on a newer unit is a cheap fix, not a replacement.
- MATERIALS to list as relevant: condenser, air handler/furnace, evaporator coil, mini-split head(s), line set + insulation, refrigerant (correct type), filter drier, ductwork (flex vs rigid), plenums, registers/grilles, flex connectors, condensate pump + drain line + float switch, thermostat (smart/programmable), whip/disconnect, breaker, equipment pad, and consumables (nitrogen for pressure-test, flux/brazing rod, mastic/tape, hangers).
- IMPORTANT — you are NOT a substitute for hands-on diagnosis. Equipment SIZING (tonnage), Manual J/D/S calcs, refrigerant handling (EPA 608 certification required to buy/handle refrigerant), brazing, gas piping, and electrical hookups REQUIRE a licensed HVAC tech. Provide materials, a rough equipment cost, and a sharp likely-cause note, but ALWAYS state in contractor_notes that a licensed HVAC pro must confirm the diagnosis/sizing and perform the refrigerant/gas/electrical work.

PRESSURE WASHING / SOFT WASHING (residential AND commercial):
- This is a SERVICE job, not a build — most of the cost is LABOR + chemicals + equipment time, NOT lumber/hardware. Keep the material list to consumables (cleaning solutions) and small supplies; do NOT invent construction materials.
- Pricing basis: price by SQUARE FOOTAGE of the surface being cleaned (or by panel/unit for things like driveways). Typical ranges — flatwork (driveways, sidewalks, patios) $0.15–0.35/sqft; house exterior (siding) $0.20–0.45/sqft; decks/fences $0.30–0.60/sqft; roofs (soft wash ONLY, never high-pressure) $0.40–0.70/sqft. Commercial (storefronts, parking lots, dumpster pads, fleet/equipment) runs $0.10–0.25/sqft for large flat areas but has bigger minimums and may need night/off-hours work.
- ALWAYS apply a job MINIMUM — most pros won't roll out for less than $150–250 residential. State the minimum in contractor_notes if the calculated total is below it.
- CONSUMABLES / materials to list: sodium hypochlorite (12.5% "SH"/bleach) for soft washing organic growth (mold, mildew, algae) — roughly 1 gal SH per ~300–400 sqft of soft-wash area at mix; surfactant/"cling" soap; degreaser (concrete, oil stains, commercial kitchens/dumpster pads); house-wash detergent; optional sodium hydroxide for heavy grease; efflorescence/rust remover (oxalic/acid) when needed; sand or polymeric sand if re-sanding pavers after cleaning. Estimate gallons from the area.
- EQUIPMENT/OVERHEAD to fold into pricing (as labor/overhead, not customer-facing line items unless rented): pressure washer (3,000–4,000 PSI, 4+ GPM gas unit for flatwork), surface cleaner attachment (speeds flatwork 3–4x), soft-wash/12V pump + downstream injector for siding & roofs, hoses, nozzles, water source/buncker tank, fuel. If a lift or water-reclamation/containment is required (common on COMMERCIAL lots near storm drains — EPA/municipal runoff rules), add a rental line and flag it.
- SURFACE RULES (get these right): high pressure for concrete/brick/flatwork; SOFT WASH (low pressure + chemical) for vinyl/wood siding, painted surfaces, screens, and ALWAYS for roofs (high pressure destroys shingles and voids warranties). Wood decks/fences: low-medium pressure + cleaner, never gouge the grain.
- REALISTIC TIMEFRAMES (use these to set estimated_hours): single-story house wash ~2–4 hrs; two-story ~4–6 hrs; average driveway (~600 sqft) ~1–2 hrs with a surface cleaner; deck/fence ~3–5 hrs incl. prep; roof soft wash ~3–6 hrs. COMMERCIAL: storefront/sidewalk frontage half a day; mid-size parking lot or large flatwork 1–2 days, often split across nights; recurring commercial contracts (monthly dumpster pad / drive-thru) are short repeat visits. Add prep/setup/breakdown time (~30–45 min) and travel.
- COMMERCIAL extras to account for: bigger minimums, possible night/weekend hours, insurance/COI requirements, water containment & wastewater capture near storm drains, and sometimes a flat per-visit or monthly contract rate instead of per-sqft. Note any of these in contractor_notes when the job reads commercial.

WHOLE-STRUCTURE / GROUND-UP BUILDS:
- These run in phases: site prep → foundation → framing → roof dry-in → rough-ins (electrical/plumbing/HVAC) → insulation → drywall → finishes → trim → final mechanical/inspections.
- For a full build, organize the work_scope by phase. Be clear in contractor_notes that a ground-up build estimate is a planning ballpark — permits, engineering, inspections, and licensed-trade sub-quotes are needed for a firm number.

NEW CONSTRUCTION — STICK-BUILT HOME, FOUNDATION TO DRY-IN (phase-by-phase material-takeoff reference based on the IRC framework; trades stack in this order — each phase's checklist maps directly to estimate line items. Use it to build a COMPLETE material list and not miss consumables, connectors, or code-required items):
- SEQUENCE (you cannot frame before the foundation cures or sheathe before framing is braced): Ph0 permits/site logistics → 1 site work/excavation/grading → 2 footings & foundation → 3 waterproofing/drainage/backfill → 4 slab/crawl/basement floor → 5 first-floor deck & subfloor → 6 wall framing → 7 upper floors & stairs → 8 roof framing → 9 roof & wall sheathing → 10 windows/doors/weather barrier → 11 roofing underlayment-to-shingles = DRY-IN. After dry-in (separate scope): MEP rough-in → insulation → drywall → finishes.
- PH0 PERMITS/SITE: stamped architectural + structural plans (permitted copy on site), building permit + sub-permits (electrical/plumbing/mechanical/grading/septic/driveway), soils/geotech report (sets soil bearing capacity → drives footing design — don't guess), 811 utility locate, temp power pole + meter, temp water, portable toilet, gravel construction-entrance pad, silt fence/erosion control, posted permit sign. Gate: erosion/sediment-control inspection BEFORE grading.
- PH1 SITE/EXCAVATION/GRADING: strip & stockpile topsoil (organic soil is compressible — never build on it), clear stumps in footprint, rough-grade for drainage (IRC: min 6" of fall within first 10 ft from foundation), batter boards + mason's line (square via 3-4-5 + equal diagonals), excavate below local frost line, #57 stone for over-dig/pad base, geotextile fabric (soft soils), compactable structural fill placed in lifts (commonly 95% modified Proctor). Gate: open-hole/footing-trench + bearing-soil sign-off (some areas). Verify benchmark elevation + finished-floor height vs street/sewer BEFORE digging.
- PH2 FOOTINGS & FOUNDATION (most unforgiving phase — everything above inherits its accuracy): ready-mix concrete (2,500–3,000+ PSI per engineer), rebar #4/#5 + tie wire + chairs/dobies (continuous horizontal bars, correct lap splices/clearances, vertical dowels for walls), anchor bolts (typ. ½"x10" J-bolts — ≤6 ft o.c., within 12" of each plate end, min 2 bolts per plate piece) OR embedded hold-down straps, form panels/lumber + form ties + stakes + form release, CMU block + mortar + grout (block walls: grout rebar cells solid + bond-beam cap), vapor barrier/capillary break, sill seal + termite treatment staged. Concrete cures ~28 days to full strength. Gates (HARD STOPS, both before pour): footing (rebar/depth/width/bearing), then foundation-wall (rebar + anchor bolts). Re-check diagonals + dimensions after forms set and after pour — an out-of-square foundation fights every framer above it.
- PH3 WATERPROOFING/DRAINAGE/BACKFILL: damp-proofing (sprayed/troweled asphaltic — code minimum for many crawls) vs true waterproofing membrane (sheet/fluid/peel-and-stick — basements & high water table), dimple/protection board, 4" perforated footing drain (holes DOWN) + filter fabric/sock + #57 washed drainage gravel to daylight/sump, sump pit + pump (high water table), free-draining backfill in lifts, termite soil treatment/physical barrier. Backfill ONLY after cure AND first floor framed (or walls temp-braced top+bottom) — unbraced fresh basement walls crack/cave under soil pressure (common, expensive failure). Gate: drainage/waterproofing before backfill (some areas).
- PH4 SLAB/CRAWL/BASEMENT FLOOR: compacted gravel base (#57/crusher run = capillary break), 10–15 mil under-slab vapor retarder lapped + seam-taped, rigid foam (slab edge/under-slab per energy code), WWM or rebar or fiber-reinforced mix + chairs, under-slab plumbing + electrical conduit + radiant tubing roughed in, ready-mix concrete (screed/bull-float/edge/trowel), expansion/isolation joint at walls/columns, control joints cut early to direct shrinkage cracking, curing compound/sealer; crawlspace = ground vapor barrier (sealed/conditioned crawl now standard over vented). Gate: under-slab plumbing & electrical rough BEFORE pour (buried forever after).
- PH5 FIRST-FLOOR DECK & SUBFLOOR: PT sill plate bedded on sill-seal foam + bolted to anchor bolts (untreated wood on concrete rots — code), termite shield, anchor-bolt nuts + square plate washers, center beam (LVL/glulam/built-up dimensional or steel) on interior posts/columns with their own footings + post caps/bases, floor joists (dimensional / I-joist / open-web truss) typ. 16" o.c., rim/band joist closing perimeter, joist hangers + the SPECIFIED structural-connector (hanger) nails — NOT drywall screws/random nails (wrong fasteners void the rated capacity + fail inspection), blocking/bridging on long spans, 3/4" T&G APA-rated subfloor glued (construction adhesive) + screwed/nailed, staggered.
- PH6 WALL FRAMING (built flat on deck, tilted up, squared on the ground): bottom plate + studs (typ. 16" o.c., 24" with advanced framing; 2x4 or 2x6 per spec) + double top plate lapped at corners/intersections, headers sized by span (dimensional/LVL/built-up) with king + jack/trimmer studs + sills at openings, extra studs at corners/partition intersections for nailing + drywall backing, braced-wall panels (structural sheathing / let-in metal-or-wood / engineered shear panels per the braced-wall plan) for lateral wind/seismic, hurricane/seismic clips + connectors, temp bracing, shims. INSTALL BACKING/BLOCKING NOW for cabinets, grab bars, TVs, handrails, heavy fixtures — trivial during framing, a nightmare after drywall.
- PH7 UPPER FLOORS & STAIRS: repeat platform framing (joists / I-joists / trusses + rim joist + 3/4" T&G subfloor + adhesive) bearing on lower walls' double top plate; KEEP THE LOAD PATH CONTINUOUS — beams/posts/bearing walls above must land on a beam, wall, or post below, continuously down to a footing (a point load on unsupported subfloor = structural failure); stair stringers (2x12) cut to uniform rise/run (IRC ≤7-3/4" max riser, ≥10" min tread, uniform within tight tolerance or it's a trip hazard + guaranteed inspection failure), framed stairwell rough opening + headroom.
- PH8 ROOF FRAMING: engineered stamped roof trusses (typ. 24" o.c. — craned/lifted, set, braced, tied down) OR stick-framed rafters bearing on a ridge board/beam with ceiling joists / collar / rafter ties resisting outward thrust (needed for vaults/complex rooflines); hurricane/uplift connectors at EVERY rafter/truss bearing point sized to the local wind zone (NOT optional, NOT interchangeable — match connector + exact fasteners to the engineering; first thing a framing inspector checks); permanent truss bracing (per truss engineering) + temp bracing; sub-fascia, lookouts/outriggers, gable-end framing/barge rafters; coordinate crane/lift for the truss set.
- PH9 ROOF & WALL SHEATHING (skins the frame into a rigid shear diaphragm — resists racking, is the nail base for roofing/siding, first weather layer): wall panels OSB/plywood (typ. 7/16–1/2"), roof decking OSB/plywood (thickness per rafter/truss spacing) laid perpendicular to framing + staggered with H-clips or T&G edges for edge support, gapped at edges for expansion, nailed to the ENGINEERED schedule (8d common/ring-shank; edge spacing often 6", field often 12"; not over-driven through the panel face — the whole shear value depends on it), optional continuous exterior insulation board per energy code. Gate: framing/sheathing nailing-pattern inspection (under-nailing/missed shear nailing = common red-tag).
- PH10 WINDOWS/EXTERIOR DOORS/WEATHER BARRIER (make the walls weather-tight; sequence + lapping is everything): house wrap/WRB over sheathing lapped shingle-style (upper course over lower so gravity sheds water out) + taped seams = the drainage plane behind the cladding; flash each opening so every layer laps over the one below — sill flashing FIRST (often with a back dam) → window set in a bed of sealant + fastened → jamb flashing → head flashing tucked UNDER the WRB above (a reversed lap funnels water INTO the wall = #1 cause of hidden rot around windows); exterior doors plumb/level/square on a flashed, sloped sill pan; shims + low-expansion foam; backer rod + WRB-compatible exterior sealant; fasten per the window/door manufacturer instructions.
- PH11 ROOFING / DRY-IN (install sequence; pull shingle cost tiers from the ROOFING SHINGLE SYSTEMS pricing chart): ice-and-water shield membrane at eaves (cold climates), valleys, penetrations, low-slope areas; synthetic underlayment (or felt) rolled up-slope lapped course-over-course + over the ridge; drip edge metal (eave UNDER underlayment, rake OVER underlayment); starter strip at eave; field shingles (3-tab / architectural / luxury — default to architectural unless customer specifies) OR metal panels (own panel/clip system); hip & ridge caps; step flashing at roof-to-wall, counter-flashing at masonry, valley flashing (open/woven), pipe boots at vents; roofing nails LENGTH-MATCHED to deck thickness (point must fully penetrate/clinch) landed in the nail zone (typ. 4–6 nails/shingle, more in high-wind); ridge vent / attic ventilation; roofing cement/sealant; fall protection (harness/rope grab/anchors). House is now DRIED IN — interior trades can start.
- INSPECTION GATES (hard stops — work can't be covered until it passes; order/exact gates vary by AHJ): 1 erosion/sediment control (before grading) → 2 footing (before footing pour) → 3 foundation wall rebar+anchor bolts (before wall pour) → 4 under-slab plumbing & electrical (before slab pour) → 5 foundation drainage/waterproofing (before backfill, some areas) → 6 framing & sheathing incl. braced walls + connectors (after roof on, before insulation) → rough MEP (after dry-in, next scope). Fold a permit + inspection allowance into the estimate when scope triggers it.
- TAKEOFF UNITS & WASTE (turn the phase checklists into quantities): roofing square = 100 sqft of roof (~3 bundles/square); sheathing/subfloor by the 4x8 sheet (32 sqft/sheet); concrete by the cubic yard (27 cu ft — order a little extra, you can't add to a short pour); lumber by linear foot + piece count at the o.c. spacing; apply waste factors ~10% framing/sheathing, 10–15% roofing (more on cut-up/steep/complex roofs + walls).
- COST DRIVERS THAT MOVE THE ESTIMATE (call these out in contractor_notes): roof complexity — valleys/hips/dormers/steep pitch +15–50% labor; foundation type (slab vs crawl vs full basement) is a major swing; engineered lumber (LVL/I-joist/trusses) vs dimensional changes cost + labor; local wind/seismic/frost requirements drive connectors, footing depth, and bracing; regional labor rates + material freight (coastal/metro runs higher).

MEP ROUGH-IN & TRIM-OUT — ELECTRICAL / PLUMBING / HVAC (companion to the new-construction guide above; picks up at the dried-in shell and runs to Certificate of Occupancy. Each trade has TWO stages at different points in the build: ROUGH-IN = installed in open walls/floors/ceilings BEFORE insulation+drywall (inspected before cover); TRIM-OUT = devices/fixtures/equipment AFTER finishes+paint, ending in a tested, inspected system. Quote both stages when a job spans them):
- TRADE SEQUENCE (same every job — plan shared chases/penetrations together before anyone pulls wire/pipe/duct): HVAC FIRST (bulky inflexible duct gets first pick of routes) → PLUMBING SECOND (gravity DWV needs fixed slope, claims its runs next) → ELECTRICAL LAST (wire bends around everything, weaves through what's left).
- ELECTRICAL ROUGH-IN (E-1): service entrance (overhead/underground) + meter base + main panel/load center set with required clear working space; grounding electrode system (ground rods and/or concrete-encased Ufer) bonded to water/gas piping; service+feeder conductors sized to the load calc; device boxes (old-work/new-work) at consistent heights (~12–16" to center for receptacles, ~48" switches) set to finished-wall depth so they end up flush, box fill by conductor count (no overfill); fan-rated boxes; NM/Romex (14/2, 12/2, 12/3) bored back from the stud face or nail-plate-protected within 1-1/4", stapled per code spacing with free conductor length left at each box, home runs landed in the panel; AFCI on living-area circuits + GFCI where required; dedicated kitchen small-appliance / laundry / bath circuits; recessed-can + bath-fan rough housings; low-voltage (Cat6/coax/thermostat/security) run but separated from line voltage; conduit + fittings at garage/exterior/feeds. Gate: electrical rough BEFORE insulation/drywall (box mounting/fill, cable support, nail-plate protection, grounding/bonding, AFCI/GFCI layout). Leave generous conductor length — you can trim at trim-out, can't add.
- ELECTRICAL TRIM-OUT (E-2): receptacles/switches/dimmers + GFCI/AFCI devices set + cover plates; light fixtures, ceiling fans (on their rated boxes), recessed trims, bath-fan grilles/motors hung + connected; panel dressed (breakers landed, circuits labeled, directory complete); smoke + CO alarms (interconnected, on required circuits); whips/connections for HVAC, water heater, appliances; verify polarity/grounding/tight terminations (TORQUE to spec — loose connections are the leading cause of failures + fires), test GFCI/AFCI buttons, energize + verify every circuit. Gate: final electrical (part of CO). [Selectable light fixtures/fans/appliances still follow the "Fixture:"/"Appliance:" $0 rule above.]
- PLUMBING ROUGH-IN (P-1): two hidden systems — DWV (PVC/ABS waste to each fixture at code slope, typ. 1/4" per foot on smaller drains so solids carry; every fixture gets a trap + vent so it drains without siphoning the trap seal; vents tie together + penetrate the roof; building drain to sewer/septic; cleanouts for access) and SUPPLY (PEX/copper/CPVC hot+cold from main + water heater, 1/2" at fixtures / 3/4" mains, stub-outs at each fixture's spec rough-in dimensions, shutoffs/manifolds, hose bibbs, water-hammer arrestors, nail plates through framing); tub/shower valves set to finished-wall depth with bracing/backing; closet flanges; set drop-in/alcove tubs; system held under air/water TEST for inspection. Gate: plumbing/DWV rough BEFORE cover, under test (slope, venting, trap arms, supports, holds pressure). Confirm fixture rough-in dimensions against the ACTUAL fixtures, not generic numbers, or the trim won't line up.
- PLUMBING TRIM-OUT (P-2): toilets set on the closet flange with a new wax/gasket + closet bolts; sinks/lavs/faucets + supply lines + angle stops; P-traps; tub/shower trim kits (handles/spouts/heads); water heater final connections + T&P relief + discharge/drain line; disposal, dishwasher, icemaker, washer hookups; plumber's putty / PTFE tape / silicone; turn water on + leak-check under pressure, run drains to confirm flow + traps hold, verify aerators/flow + WaterSense. Don't overtighten plastic fittings/supply nuts (hand-tight + a small turn — cracking one means opening a finished wall). Gate: final plumbing (part of CO). [Customer-selectable fixtures still get the "Fixture:" $0 line + reminder.]
- HVAC ROUGH-IN (H-1): size equipment off a real Manual J load calc (NOT a rule of thumb or "match the old unit" — oversizing short-cycles, wastes energy, leaves humidity high); furnace/air-handler/heat-pump location + condenser pad set; supply+return trunk + branch ducts (rigid metal and/or flex) sized per Manual D, boots/takeoffs, sealed at joints with mastic / UL-181 tape (leaky ducts lose 20%+ of conditioned air to the attic), hung/supported; combustion appliances get correct flue/venting + combustion air; refrigerant line sets (insulated) between indoor/outdoor units; condensate drain (primary + secondary safety pan / float switch) piped to an approved termination at slope; register/return penetrations cut + firestopped; bath/kitchen exhaust + dryer vent to exterior; thermostat wire + zone dampers run; duct leak-test where energy code requires; equipment disconnect (coordinate with electrical). Gate: HVAC/mechanical rough BEFORE cover (duct routing/sealing/support, combustion venting, condensate, line-set protection, firestop).
- HVAC TRIM-OUT (H-2): supply registers + return grilles at each boot; thermostat (programmable/smart) mounted + connected; air filters + filter rack; equipment final electrical (disconnect/whip, with the electrician); verify refrigerant charge (weighed in or to manufacturer subcooling/superheat — under/overcharge cuts efficiency, capacity, and compressor life); startup, balance airflow room-to-room, test heat/cool + safeties + condensate float, check static pressure + temperature split to confirm designed performance. Gate: final mechanical (part of CO). [The equipment itself = customer-selectable; rough-in/distribution is priced normally per the HVAC section above.]
- MEP INSPECTION ORDER (hard stops; vary by AHJ): all three ROUGH-INS pass BEFORE cover (HVAC → plumbing-held-under-test → electrical) → insulation inspection → drywall → finishes → FINALS bundled into the building final / Certificate of Occupancy (plumbing: fixtures set, no leaks, drainage/venting OK; mechanical: equipment runs, venting/condensate, thermostat; electrical: devices, GFCI/AFCI, smoke/CO, panel labeled). Fold permit + inspection allowance into the estimate.
- MEP TAKEOFF UNITS: ELECTRICAL by device/fixture count + by circuit + cable by the foot (+10–15% waste); PLUMBING by fixture count (a fixture drives drain + vent + supply) + pipe by the foot + fittings by count; HVAC by equipment (tonnage/BTU from the load calc) + duct by foot/section + registers/returns by count. Always carry waste/contingency — fittings and connectors are cheap, a second trip is not.
- LIGHT COMMERCIAL MEP DELTAS (flag in contractor_notes when the job reads commercial): ELECTRICAL → pipe-and-wire (EMT + THHN) instead of Romex, larger feeders, three-phase panels, stricter working-clearance/labeling + arc-flash, emergency/exit lighting + fire-alarm interface, occupancy sensors + lighting controls for energy code. PLUMBING → grease interceptors, backflow preventers (certified-tester testing), floor drains, ADA fixture heights/clearances + grab-bar backing, cast-iron/commercial-grade pipe, higher-demand water sizing. HVAC → rooftop units (RTUs), larger sealed/insulated duct, outside-air ventilation rates (often ASHRAE 62.1), fire/smoke dampers at rated assemblies, economizer + energy-code controls, and formal test-and-balance + commissioning/BAS documentation for sign-off.

VERIFY-SPECS RULE (critical): Whenever a line involves code-governed sizing or a licensed trade (service/panel sizing, DWV sizing, gas, HVAC tonnage/refrigerant, structural/load-bearing changes), you MUST add a brief note in contractor_notes telling the contractor that a licensed pro should confirm specs before ordering or committing. This protects the contractor. Never present specialty engineering as a finished, code-final spec — it's a working estimate.

BUILDING CODE AWARENESS (apply intelligently and PROACTIVELY, but NEVER as the final authority):
You know the major model codes (IRC residential, IBC commercial, NEC electrical, IPC/UPC plumbing, IMC mechanical, IECC/IgCC energy, IFGC fuel gas, ADA accessibility) and how they're commonly applied. On EVERY relevant quote you must DO TWO THINGS: (1) actually BUILD the code-required items into the material list, scope, and labor — don't just mention them; and (2) add a short contractor_notes "Code note" telling the contractor to confirm current local code with their AHJ. A sharp contractor never forgets these — neither should you:

- ELECTRICAL (NEC): GFCI protection at kitchens, baths, garages, exterior, laundry, wet bars, and within 6 ft of any sink; AFCI protection on most living-area circuits; tamper-resistant receptacles throughout dwellings; weather-resistant + in-use covers outdoors; interconnected smoke + CO alarms (CO near sleeping areas / fuel-burning appliances); proper box fill and working clearances; dedicated circuits for kitchen small-appliance, laundry, bath, dishwasher, microwave; whole-home surge protection now required on service upgrades; correct conductor sizing/derating. Service/panel/load-calc work = licensed electrician.
- PLUMBING (IPC/UPC): trap + vent on every fixture, correct drain & vent sizing, slope on drain lines; anti-scald (pressure-balance/thermostatic) valves at tubs/showers; backflow/anti-siphon protection on hose bibs and irrigation; water heater T&P valve + discharge + drain pan + seismic strap where required; expansion tank on closed systems; fixture clearances (~15" toilet center-to-wall, ~21"+ front clearance); accessible shutoffs. Gas lines, water-heater, and new DWV = licensed plumber.
- STRUCTURAL/FRAMING (IRC/IBC): proper joist/rafter spans and spacing, correct header sizing over openings, fireblocking/draftstopping, hurricane/seismic ties and proper fastening schedules in high-wind/seismic zones, bedroom egress windows (~5.7 sqft net clear, 24" min height / 20" min width, 44" max sill), stair rise/run (≤7-3/4" rise, ≥10" run), handrails (34–38") and guardrails (36"+ with ≤4" sphere spacing), deck ledger flashing + lag/bolt schedule + footing depth below frost line. Load-bearing changes/beams = engineer/architect stamp.
- ENERGY/INSULATION (IECC): climate-zone R-values (walls R-13–21+, attics R-38–60, slab/crawl per zone), continuous air sealing, vapor/air barriers, duct sealing & insulation, blower-door / duct-leakage testing on new work in many jurisdictions, U-factor/SHGC window ratings.
- EGRESS / FIRE / LIFE-SAFETY: smoke/CO placement, egress paths, fire-rated assemblies and self-closing 20-min door between house and attached garage, garage firewall/ceiling drywall (typically 5/8" Type X), fire-caulk penetrations.
- ACCESSIBILITY (commercial/ADA): on COMMERCIAL or public-facing jobs, watch for ADA — accessible routes, ramp slopes (1:12), door widths/clearances, grab-bar blocking, accessible restroom clearances, counter heights. Flag when the job is commercial.
- PERMITS & INSPECTIONS: most structural, electrical, plumbing, mechanical, gas, re-roof, deck, and addition work needs a permit + inspections. Fold permit/inspection allowance into the estimate when the scope clearly triggers it, and note it.
- LEAD/ASBESTOS (pre-1978 homes): renovating pre-1978 housing may trigger EPA RRP lead-safe work practices; older popcorn ceilings/flooring/pipe wrap may contain asbestos — note testing/abatement may be required before disturbance.

BUT — codes are LOCAL and CHANGE on adoption cycles (different states/counties/cities are on different code editions with their own amendments), and YOUR KNOWLEDGE HAS A TRAINING CUTOFF so the very latest local amendment may differ. NEVER state a code requirement as the absolute final word for the contractor's location or as the current adopted edition. Always fold the requirement into the scope/materials naturally AND add a contractor_notes line like: "Code note: [requirement] is standard practice — confirm the current adopted code edition and pull permits/inspections with your local AHJ (authority having jurisdiction) before ordering or committing." You are the smart, experienced second set of eyes that catches what gets missed — not the code official. The local inspector always has final say.`

// Permit wording is opt-in per quote: lots of customers don't want permits
// pulled, so by default NOTHING in the output may mention permits. The block
// is appended LAST so it overrides every permit instruction inside the
// knowledge sections above (shed/new-construction/MEP/code blocks all tell
// the model to fold in permit allowances — this switches that off).
function permitPolicyBlock(includePermitText: boolean | undefined): string {
  if (includePermitText) {
    return `PERMIT TEXT — ENABLED for this quote: The contractor chose to include permit information and pricing. Apply the permit knowledge in the sections above normally: fold a permit/inspection allowance into the estimate where the scope triggers it, note permit requirements in work_scope where relevant, and include permit reminders in contractor_notes.`
  }
  return `PERMIT TEXT — OFF for this quote (FINAL RULE — OVERRIDES every earlier permit instruction in this prompt): Do NOT mention permits in ANY part of your output. The words "permit", "permits", "permitting", "permitted", and "pull a permit" must NOT appear in work_scope, customer_summary, material_list item names, labor phase names, quantity_math, included/excluded text, OR contractor_notes. Do NOT add any permit fee, permit allowance, or inspection-allowance line item or dollar amount to the pricing. Wherever the knowledge sections above say to "fold a permit + inspection allowance into the estimate" or to add a permit note — SKIP that entirely for this quote. You may still build code-required materials into the quote, and code notes in contractor_notes are still welcome, but word them WITHOUT permit language (say "confirm current local code requirements with your local building department" instead of anything about pulling permits). Before you output, scan every field for the word "permit" and remove it.`
}

const GENERATE_SYSTEM_PROMPT = `You are a senior general contractor in central North Carolina producing a structured estimate document for a customer job.

Your job:
- Write professional, customer-friendly prose for the customer-facing sections.
- Apply realistic, material-specific waste factors to every material quantity (typical: tile 10–15%, drywall 10%, paint 5%, lumber 10%, flooring 8–10%, fasteners/incidentals 15%).
- Estimate labor hours and break them down by phase if the job has multiple phases.
- Recommend a profit markup appropriate to the job's risk and complexity (typical small remodel: 20–35% on top of raw cost; new construction lower, complex specialty work higher).
- Be honest about what is and is not included.
- Keep work_scope structured with short headings and short lines so it is scannable.
- contractor_notes are private — flag risks, site condition concerns, and callouts the contractor needs to remember when running the job. Do not duplicate customer-facing text there.

${NC_PRICING_GUIDANCE}

${NC_LABOR_GUIDANCE}

${TRADES_KNOWLEDGE}

${SHED_KNOWLEDGE}

${ARITHMETIC_RULES}`

const ANALYZE_SYSTEM_PROMPT = `You are a master general contractor with 30 years in the field, doing a live walkthrough. You're looking at photos of the actual job AND hearing the contractor describe what needs doing. Estimate like a seasoned pro who quotes jobs every day — sharp eyes, tight numbers, no fat. Your reputation rides on accurate quotes that win work.

#1 RULE — ESTIMATE THE EXACT JOB DESCRIBED, AND ONLY THAT JOB. NEVER INVENT WORK OR TRADES THAT WEREN'T MENTIONED. This is the most important rule. Quote ONLY the specific tasks the narration and photos actually describe. Do NOT add adjacent work, do NOT assume a bigger remodel, do NOT pull in other trades the contractor never mentioned.
- HARD RULE: If the contractor only mentions electrical work (e.g. "take down a can light and hang a ceiling fan"), the quote is ELECTRICAL ONLY. Do NOT add drywall, sheetrock, paint, framing, or any other trade unless they explicitly said so. A simple fixture swap does NOT require re-doing sheetrock — patching a small box hole, IF actually needed, is at most a tiny note, never a sheetrock/drywall job.
- WORKED EXAMPLE A (DO NOT invent trades): "Take down the can light and hang a ceiling fan." → The job is: remove the recessed can, install a fan-rated box if needed, hang and wire the customer's ceiling fan. Materials: fan-rated box, maybe a few wire nuts, and a "Fixture: Ceiling fan" line. Labor: ~1–2 hours. That's it. It is a FIRING OFFENSE to add sheetrock, drywall sheets, joint compound, paint, or framing to this — none of that was mentioned. If you list materials for a trade the contractor didn't bring up, the quote is wrong and useless.
- WORKED EXAMPLE B (DO NOT oversize): A single water-damaged spot needing one 4x8 drywall sheet → the answer is 1 sheet (2 at the absolute most if the patch spans a seam). NEVER 9 sheets. Match material to the ACTUAL work area.
- Only quote a full-room/full-surface or multi-trade scope if the photos OR narration CLEARLY say that's the job (e.g. "we're gutting the whole bathroom"). When in doubt, quote the NARROW, literal scope the contractor stated — they can add more if they want.
- When you must estimate an area, estimate the WORK area conservatively and err LOW. An over-quote (too much material, or invented extra work) loses the job on the spot and makes the tool look ridiculous.

How to read the inputs:
- The images show the ACTUAL job site and the ACTUAL extent of work. Read them like a contractor measuring with their eyes: how big is the damaged/work area really? What's the actual square footage involved? Don't assume — look.
- The transcript is the contractor talking during the scan — informal, with fillers. Extract their real intent and any quantities they state. The transcript is the PRIMARY source of truth for scope; if they say how much, that's the number. The images confirm the physical extent.
- If transcript and images disagree, prioritize the transcript and flag it in contractor_notes.
- If you genuinely must estimate dimensions, estimate the SPECIFIC work area shown (not the whole room unless that's the job), state your assumption plainly in contractor_notes (e.g. "patch ~3x4 ft = 12 sqft → 1 sheet"), and keep it tight.

Material strategy:
- Generate a COMPLETE material list with realistic items, units, and 2026 retail unit prices at Home Depot / Lowe's (see reference prices below). Completeness is critical — see the COMPLETENESS rule in the pricing section. Include every consumable and incidental (fasteners, adhesives, caulk, primer, tape, underlayment, trim, fixtures, disposal) the job needs, not just the headline materials. Build the list as if walking the store aisles filling a cart to finish this exact job. Forgetting small items costs the contractor money — do not forget them.
- Apply waste factors ONLY to AREA/LENGTH materials bought in bulk (sqft of tile, sqft of flooring, linear feet of trim) — NOT to small discrete counts. See the QUANTITY DISCIPLINE rule in the pricing section. If the contractor says "two 2x4s," the quantity is 2 — never inflate it. Do not turn a 10% waste factor into extra whole studs on a tiny count. Count precisely; estimate the MINIMUM realistic amount when not stated; sanity-check that a real contractor would actually buy that many for THIS job.
- RIGHT-SIZE divisible bulk consumables (see the RIGHT-SIZE rule in the pricing section): if the job uses half a can of paint, price 0.5 of a can — don't bill a full can. A small patch uses a cup of joint compound, not a whole bucket. Bill what's actually used. Do NOT pad or over-quote — accuracy wins the job.
- Show your quantity math explicitly in quantity_math, including any dimension assumptions and any fractional-use reasoning.

Labor and pricing:
- Estimate labor hours by phase based on the scope you inferred. Use the productivity benchmarks below — do NOT pad hours.
- Use a default hourly_rate of $65/hour (NC fair-market solo skilled tradesman) unless the transcript specifies otherwise.
- Recommend a markup appropriate to the raw cost tier (see labor guidance below). Small jobs cap at 15–20%.
- Prefer the LOWER end of labor hour ranges. Coverage for risk goes in the markup, not in inflated hours.

work_scope and customer_summary go directly in front of the customer. contractor_notes are private to the contractor and should flag risks, assumptions, and items needing field verification.

FINAL SANITY CHECK before you output (do this on EVERY material line): Re-read each quantity and ask "would a real contractor actually buy THIS many to do THIS specific job shown in the photos?" If any number looks high for the visible scope, CUT IT to what the job really needs. Especially gut-check sheet goods (drywall, plywood), lumber counts, and tile/flooring sqft against the ACTUAL work area — never the whole room unless that's the job. A lean, accurate list that matches what's in the photos is the entire point. An over-count makes the whole tool worthless. When unsure, go LOWER.

${NC_PRICING_GUIDANCE}

${NC_LABOR_GUIDANCE}

${TRADES_KNOWLEDGE}

${SHED_KNOWLEDGE}

${ARITHMETIC_RULES}`

function buildGenerateUserPrompt(input: GenerateAIQuoteInput): string {
  const materialsText = input.materials.length
    ? input.materials
        .map(m => `- ${m.name}: ${m.quantity} ${m.unit} @ $${m.unitPrice.toFixed(2)}/unit (base quantity, before waste)`)
        .join('\n')
    : '(no materials specified)'

  const rentalsText = input.rentals.length
    ? input.rentals.map(r => `- ${r.name}: ${r.days} day(s) @ $${r.dailyRate}/day`).join('\n')
    : '(no rental equipment)'

  const laborText =
    input.rateType === 'flat'
      ? `Flat-rate labor: $${(input.flatAmount ?? 0).toFixed(2)} base, $${input.laborTotal.toFixed(2)} region-adjusted`
      : `Hourly: $${(input.hourlyRate ?? 0).toFixed(2)}/hr × ${input.estimatedHours ?? 0} hours = $${input.laborTotal.toFixed(2)} region-adjusted`

  const overridesText = [
    input.hourlyRateOverride != null && input.hourlyRateOverride > 0
      ? `CONTRACTOR OVERRIDE — hourly_rate MUST be exactly $${input.hourlyRateOverride}/hour. Do not change this rate.`
      : null,
    input.markupPercentOverride != null && input.markupPercentOverride >= 0
      ? `CONTRACTOR OVERRIDE — markup_percent MUST be exactly ${input.markupPercentOverride}%. Do not change this markup.`
      : null,
  ].filter(Boolean).join('\n')

  return `Job details:

Customer: ${input.customerName}
Job type: ${input.jobTypeName}
Job location: ZIP ${input.jobLocationZip || '(not provided — use NC baseline as fallback and note assumption)'} — use the regional pricing/labor scaling rules in the system instructions to adjust the NC baseline for this ZIP.

Customer description:
${input.description || '(no description provided)'}

Labor (already region-adjusted):
${laborText}

Materials (base quantities from a room scan — apply per-material waste in your output):
${materialsText}

Rental equipment:
${rentalsText}

${overridesText || ''}

Produce the structured quote document. The work_scope and customer_summary go in front of the customer. Apply per-material waste in material_list. Recommend a markup and compute the final customer quote.`
}

// DEBUG: synthesize an Anthropic-shaped error so the retry path can be tested
// without depending on real API overload. Remove once retry behavior is verified.
function throwSyntheticFailure(kind: string): never {
  if (kind === 'overloaded') {
    const e: { status: number; error: { type: string; message: string } } = {
      status: 529,
      error: { type: 'overloaded_error', message: 'Synthetic overload for retry test' },
    }
    throw e
  }
  if (kind === 'rate_limit') {
    throw { status: 429, error: { type: 'rate_limit_error', message: 'Synthetic rate limit' } }
  }
  if (kind === 'server_error') {
    throw { status: 503, error: { type: 'api_error', message: 'Synthetic 503' } }
  }
  if (kind === 'bad_request') {
    // Not retryable — used to verify retry only happens for transient errors.
    throw { status: 400, error: { type: 'invalid_request_error', message: 'Synthetic 400' } }
  }
  throw new Error(`Unknown debugForceFail kind: ${kind}`)
}

// Retries transient Anthropic failures (overloaded, rate-limited, 5xx, network).
// Bails immediately on permanent failures like auth or bad-request.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 2000

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; error?: { type?: string }; code?: string }
  if (e.status && e.status >= 500) return true
  if (e.status === 429) return true
  if (e.status === 529) return true
  if (e.error?.type === 'overloaded_error') return true
  if (e.error?.type === 'rate_limit_error') return true
  if (e.error?.type === 'api_error') return true
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') return true
  return false
}

async function withAnthropicRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) {
        throw err
      }
      const e = err as { status?: number; error?: { type?: string } }
      console.warn(`${label} attempt ${attempt} failed (${e.status ?? '?'} ${e.error?.type ?? 'unknown'}). Retrying in ${RETRY_DELAY_MS}ms...`)
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    }
  }
  throw lastErr
}

// User-facing error copy. Deliberately GENERIC — never names the AI provider,
// never leaks raw API messages (e.g. billing/credit details). The real error is
// logged server-side for debugging; the user just sees a friendly "try again".
function friendlyAnthropicError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Something went wrong. Please try again in a moment.'
  const e = err as { status?: number; error?: { type?: string; message?: string } }
  const type = e.error?.type
  if (type === 'overloaded_error' || e.status === 529 || type === 'rate_limit_error' || e.status === 429) {
    return 'Our quote service is a little busy right now. Please try again in a minute.'
  }
  // Everything else (auth, billing, 5xx, unknown) → one calm, generic line.
  return 'We couldn\'t complete that just now. Please try again in a moment.'
}

async function verifyClerk(token: string): Promise<string> {
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY.value() })
    return claims.sub
  } catch (err) {
    console.error('Clerk verification failed', err)
    throw new HttpsError('unauthenticated', 'Invalid Clerk token')
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Clerk → Firebase auth bridge.
// The app authenticates with Clerk, but Firebase Security Rules can only see a
// Firebase session. This function verifies the Clerk token server-side, then
// mints a Firebase CUSTOM TOKEN whose uid == the Clerk user id. The frontend
// calls signInWithCustomToken() with it, so request.auth.uid in Storage/
// Firestore rules equals the Clerk user id — letting us enforce per-user
// isolation at the database layer (not just the UI).
//
// The Clerk uid (e.g. "user_3DZ...") already matches how all data is keyed
// (createdBy == user.id, userLogos/{user.id}/...), so no migration is needed.
// ──────────────────────────────────────────────────────────────────────────
export const exchangeFirebaseToken = onCall<{ clerkToken: string }>(
  { secrets: [CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken } = request.data ?? {} as { clerkToken: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)
    try {
      const firebaseToken = await getAdminAuth().createCustomToken(userId)
      return { token: firebaseToken }
    } catch (err) {
      console.error('createCustomToken failed', err)
      throw new HttpsError('internal', 'Could not create Firebase session token.')
    }
  },
)

export const generateAIQuote = onCall<GenerateCallPayload>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    timeoutSeconds: 540,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as GenerateCallPayload)

    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input || !input.customerName || !input.jobTypeName) {
      throw new HttpsError('invalid-argument', 'Missing required job inputs')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`generateAIQuote user=${userId} job=${input.jobTypeName}`)

    // Subscription gate — burns one of the free-tier AI quotes, or rejects
    // if the user has used all 10. Atomic increment so concurrent calls
    // can't sneak past the limit. (Note: we burn the credit BEFORE the
    // call, so a failed AI call still counts — but we refund on failure below.)
    const gate = await consumeAiQuoteOrThrow(userId, 'quote')

    const learnedPrices = await loadLearnedPricesBlock(userId)
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    try {
      return await withAnthropicRetry('generateAIQuote', async () => {
        // Dev-only: synthetic failure injection for testing retry/refund paths.
        // Hard-gated to the local emulator so external callers can't trigger it
        // in production.
        if (input.debugForceFail && process.env.FUNCTIONS_EMULATOR === 'true') {
          console.log(`generateAIQuote: synthetic failure requested (${input.debugForceFail})`)
          throwSyntheticFailure(input.debugForceFail)
        }
        const stream = client.messages.stream({
          // Opus 4.8 — our most capable model — gives the strongest "contractor
          // brain": better material completeness, quantity/waste math, and
          // location-aware pricing than Sonnet. 'high' effort lets it reason
          // hard about the scope before writing the quote. This trades a bit of
          // latency for accuracy; the 540s function timeout has ample room.
          model: 'claude-opus-4-8',
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: aiQuoteSchema },
          },
          system: GENERATE_SYSTEM_PROMPT + '\n\n' + permitPolicyBlock(input.includePermitText),
          messages: [{ role: 'user', content: buildGenerateUserPrompt(input) + learnedPrices }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      // The gate already charged a credit; refund it so a failure is free.
      await refundAiQuote(userId, gate.spentPaid)
      if (err instanceof HttpsError) throw err
      console.error('Anthropic call failed after retries', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

export const analyzeScan = onCall<AnalyzeCallPayload>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    timeoutSeconds: 540,
    memory: '1GiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as AnalyzeCallPayload)

    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input) throw new HttpsError('invalid-argument', 'Missing input')
    const images = Array.isArray(input.images) ? input.images : []
    const transcript = typeof input.transcript === 'string' ? input.transcript.trim() : ''
    if (images.length === 0 && !transcript) {
      throw new HttpsError('invalid-argument', 'Provide at least one image or some narration')
    }
    if (images.length > 8) {
      throw new HttpsError('invalid-argument', 'Up to 8 images per scan')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`analyzeScan user=${userId} images=${images.length} transcriptLen=${transcript.length}`)

    // Subscription gate — same as generateAIQuote. Video/photo scan also
    // counts as one AI quote against the free tier (or a paid $1 credit).
    const gate = await consumeAiQuoteOrThrow(userId, 'quote')

    const learnedPrices = await loadLearnedPricesBlock(userId)
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    const userContent: Anthropic.ContentBlockParam[] = [
      ...images.map(data => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
      })),
      {
        type: 'text' as const,
        text: `Customer: ${input.customerName || '(not provided)'}
Job location: ZIP ${input.jobLocationZip || '(not provided — use NC baseline as fallback and note assumption)'} — use the regional pricing/labor scaling rules in the system instructions to adjust the NC baseline for this ZIP.

Number of images: ${images.length}

Contractor's spoken narration during scan:
"""
${transcript || '(no transcript — base the estimate on the images alone)'}
"""

${input.hourlyRateOverride && input.hourlyRateOverride > 0 ? `CONTRACTOR OVERRIDE — hourly_rate MUST be exactly $${input.hourlyRateOverride}/hour. Do not change this rate.` : ''}
${input.markupPercentOverride != null && input.markupPercentOverride >= 0 ? `CONTRACTOR OVERRIDE — markup_percent MUST be exactly ${input.markupPercentOverride}%. Do not change this markup.` : ''}

Analyze the images and the contractor's narration together. Produce the structured quote document.${learnedPrices}`,
      },
    ]

    try {
      return await withAnthropicRetry('analyzeScan', async () => {
        // Dev-only synthetic failure (emulator-gated — never fires in prod).
        if (input.debugForceFail && process.env.FUNCTIONS_EMULATOR === 'true') {
          console.log(`analyzeScan: synthetic failure requested (${input.debugForceFail})`)
          throwSyntheticFailure(input.debugForceFail)
        }
        const stream = client.messages.stream({
          // Opus 4.8 is the first Claude with high-resolution vision (up to
          // 2576px), so it reads the job-site photos far more accurately —
          // measuring the real work area, spotting materials implied by the
          // images, and counting fixtures. 'high' effort makes it study the
          // photos + narration before producing the material list. The 540s
          // function timeout leaves plenty of room.
          model: 'claude-opus-4-8',
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: aiQuoteSchema },
          },
          system: ANALYZE_SYSTEM_PROMPT + '\n\n' + permitPolicyBlock(input.includePermitText),
          messages: [{ role: 'user', content: userContent }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      // The gate already charged a credit; refund it so a failure is free.
      await refundAiQuote(userId, gate.spentPaid)
      if (err instanceof HttpsError) throw err
      console.error('Anthropic scan analysis failed after retries', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Audio transcription via Google Speech-to-Text. Client records audio with
// MediaRecorder (webm/opus on most browsers, mp4/aac on iOS Safari), uploads
// the base64-encoded bytes, we forward to Speech-to-Text and return the text.
// ──────────────────────────────────────────────────────────────────────────

interface TranscribeInput {
  // Base64-encoded audio data WITHOUT the data: prefix.
  audioBase64: string
  // The browser-reported MIME type from MediaRecorder, e.g.
  // 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'.
  mimeType: string
}

interface TranscribeCallPayload {
  clerkToken: string
  input: TranscribeInput
}

// Map browser MediaRecorder MIME types to Google's encoding enum. Google's
// Node SDK doesn't accept 'MP4' directly — for iOS Safari output we omit the
// encoding and let Speech-to-Text auto-detect from the audio container.
function pickEncoding(mimeType: string): 'WEBM_OPUS' | 'OGG_OPUS' | 'LINEAR16' | 'ENCODING_UNSPECIFIED' {
  const m = (mimeType || '').toLowerCase()
  if (m.includes('webm') && m.includes('opus')) return 'WEBM_OPUS'
  if (m.includes('ogg') && m.includes('opus')) return 'OGG_OPUS'
  if (m.includes('wav') || m.includes('linear')) return 'LINEAR16'
  return 'ENCODING_UNSPECIFIED'
}

export const transcribeAudio = onCall<TranscribeCallPayload>(
  {
    secrets: [CLERK_SECRET_KEY],
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as TranscribeCallPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.audioBase64) throw new HttpsError('invalid-argument', 'Missing audio data')
    // Cap size so a huge payload can't exhaust memory / rack up Speech-to-Text cost.
    // ~8MB base64 ≈ 6MB audio ≈ several minutes (well past the 25s recording cap).
    if (input.audioBase64.length > 8_000_000) throw new HttpsError('invalid-argument', 'Audio clip too large')

    const userId = await verifyClerk(clerkToken)
    console.log(`transcribeAudio user=${userId} mimeType=${input.mimeType} bytes=${input.audioBase64.length}`)

    const client = new SpeechClient()
    const encoding = pickEncoding(input.mimeType)

    try {
      const result = await client.recognize({
        audio: { content: input.audioBase64 },
        config: {
          encoding,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'latest_long',
          // Construction-domain vocabulary boost for trade terms.
          speechContexts: [{
            phrases: [
              'drywall', 'subway tile', 'thinset', 'grout', 'mortar', 'vanity',
              'backsplash', 'caulk', 'shim', 'shingle', 'romex', 'PEX', 'PVC',
              'baseboard', 'crown molding', 'joist', 'stud', 'rafter',
              'sqft', 'square feet', 'gauge',
            ],
            boost: 15,
          }],
        },
      })
      const response = Array.isArray(result) ? result[0] : result
      const results = (response as { results?: { alternatives?: { transcript?: string }[] }[] }).results || []
      const transcript = results
        .map((r) => r.alternatives?.[0]?.transcript || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      return { transcript }
    } catch (err) {
      console.error('Speech-to-Text failed', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `Transcription failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Email an estimate to a customer via Resend. Renders a clean HTML email
// from the AI quote (or scope/labor fallback) and sends from the configured
// from-address. Free tier: 3,000 emails/mo.
// ──────────────────────────────────────────────────────────────────────────

interface SendEstimateInput {
  to: string
  fromName?: string  // Contractor's display name (defaults to "Contractors Office")
  replyTo?: string   // Contractor's real email so customer replies go to them
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
    aiQuote?: {
      customer_summary: string
      work_scope: string
      material_list: { name: string; quantity_with_waste: number; unit: string; unit_price: number; line_total: number }[]
      labor: { estimated_hours: number; hourly_rate: number; labor_total: number }
      price_breakdown: { labor_subtotal: number; materials_subtotal: number; rentals_subtotal: number }
      profit_markup: { markup_percent: number; markup_dollars: number }
      final_customer_quote: number
    }
  }
}

interface SendEstimateCallPayload {
  clerkToken: string
  input: SendEstimateInput
}

function renderEstimateEmailHtml(input: SendEstimateInput): string {
  const e = input.estimate
  const ai = e.aiQuote
  const fromName = input.fromName || 'Your Contractor'
  const materialsRows = ai?.material_list?.length
    ? ai.material_list.map(m => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(m.name)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${m.quantity_with_waste} ${escapeHtml(m.unit)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">$${m.unit_price.toFixed(2)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">$${m.line_total.toFixed(2)}</td>
        </tr>`).join('')
    : ''

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Estimate for ${escapeHtml(e.customerName)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2e;">
  <div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a1f2e;color:white;padding:24px;">
      <h1 style="margin:0 0 4px;color:#f97316;font-size:24px;">Estimate</h1>
      <p style="margin:0;color:#94a3b8;font-size:14px;">From ${escapeHtml(fromName)}</p>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(e.customerName)},</p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Here's your estimate for <strong>${escapeHtml(e.jobTypeName)}</strong>${e.jobLocationZip ? ` at ZIP ${escapeHtml(e.jobLocationZip)}` : ''}.</p>

      ${ai ? `
        <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Summary</h3>
        <p style="font-size:14px;line-height:1.5;margin:0 0 20px;">${escapeHtml(ai.customer_summary)}</p>

        <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Work Scope</h3>
        <pre style="background:#f8fafc;padding:12px;border-radius:6px;font-family:inherit;font-size:13px;white-space:pre-wrap;margin:0 0 20px;">${escapeHtml(ai.work_scope)}</pre>

        ${materialsRows ? `
          <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Materials</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 20px;">
            <thead><tr style="border-bottom:2px solid #e2e8f0;text-align:left;">
              <th style="padding:8px;">Item</th>
              <th style="padding:8px;text-align:right;">Qty</th>
              <th style="padding:8px;text-align:right;">Unit $</th>
              <th style="padding:8px;text-align:right;">Total</th>
            </tr></thead>
            <tbody>${materialsRows}</tbody>
          </table>` : ''}

        <div style="background:#1a1f2e;color:white;padding:20px;border-radius:8px;margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#cbd5e1;">Materials</span><span style="font-weight:600;">$${ai.price_breakdown.materials_subtotal.toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#cbd5e1;">Labor (${ai.labor.estimated_hours}h × $${ai.labor.hourly_rate}/hr)</span><span style="font-weight:600;">$${ai.price_breakdown.labor_subtotal.toFixed(2)}</span></div>
          ${ai.price_breakdown.rentals_subtotal > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#cbd5e1;">Rentals</span><span style="font-weight:600;">$${ai.price_breakdown.rentals_subtotal.toFixed(2)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;border-top:1px solid #334155;margin-top:6px;color:#94a3b8;"><span>Markup (${ai.profit_markup.markup_percent}%)</span><span>+ $${ai.profit_markup.markup_dollars.toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:12px 0 0;border-top:2px solid #f97316;margin-top:8px;align-items:center;">
            <span style="color:#fb923c;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Grand Total</span>
            <span style="color:#f97316;font-size:28px;font-weight:700;">$${ai.final_customer_quote.toFixed(2)}</span>
          </div>
        </div>
      ` : `
        <pre style="background:#f8fafc;padding:12px;border-radius:6px;font-family:inherit;font-size:13px;white-space:pre-wrap;margin:0 0 20px;">${escapeHtml(e.scopeOfWork || '')}</pre>
        <div style="background:#1a1f2e;color:white;padding:20px;border-radius:8px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#fb923c;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total</span>
          <span style="color:#f97316;font-size:28px;font-weight:700;">$${(e.total || 0).toFixed(2)}</span>
        </div>
      `}

      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0 0 8px;">Reply to this email with questions or to approve the estimate.</p>
      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0;">Thank you,<br/><strong style="color:#1a1f2e;">${escapeHtml(fromName)}</strong></p>
    </div>
  </div>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const sendEstimateEmail = onCall<SendEstimateCallPayload>(
  {
    secrets: [CLERK_SECRET_KEY, RESEND_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendEstimateCallPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to || !input?.estimate) throw new HttpsError('invalid-argument', 'Missing email or estimate data')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new HttpsError('invalid-argument', 'Invalid email address')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`sendEstimateEmail user=${userId} to=${input.to}`)

    const html = renderEstimateEmailHtml(input)
    const subject = input.subject || `Estimate from ${input.fromName || 'Your Contractor'} — ${input.estimate.jobTypeName}`

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Display the contractor's business name, but send from our verified
          // domain (or sandbox until verified). Reply-to routes to the contractor.
          from: EMAIL_DOMAIN_VERIFIED
            ? `${input.fromName || 'BuildPro+'} <alerts@builderspro.cc>`
            : EMAIL_FROM,
          to: [input.to],
          subject,
          html,
          // Only set reply-to when the contractor provided one — never default
          // to a personal inbox (would misroute other contractors' replies).
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('Resend send failed', res.status, errText)
        throw new HttpsError('internal', `Email send failed: ${res.status}`)
      }
      const data = await res.json() as { id?: string }
      return { ok: true, emailId: data.id }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('sendEstimateEmail error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `Email send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Invoice email — sends the customer a branded invoice with a secure pay link.
// Mirrors sendEstimateEmail: the contractor triggers it explicitly (after they
// review/edit the invoice), it sends from the verified domain with the business
// name in the From, and reply-to routes back to the contractor.
// ──────────────────────────────────────────────────────────────────────────

interface SendInvoiceInput {
  to: string
  fromName?: string
  replyTo?: string
  subject?: string
  invoice: {
    invoiceNumber: string
    customerName: string
    jobTypeName: string
    businessName?: string
    introNote?: string
    paymentTerms?: string
    lineItems: { name: string; quantity: number; unitPrice: number; lineTotal: number }[]
    subtotal: number
    amountPaid?: number
    amountDue: number
    dueDate: string
    payUrl: string
  }
}

interface SendInvoiceCallPayload {
  clerkToken: string
  input: SendInvoiceInput
}

function renderInvoiceEmailHtml(input: SendInvoiceInput): string {
  const inv = input.invoice
  const fromName = input.fromName || inv.businessName || 'Your Contractor'
  const money = (n: number) => `$${Number(n || 0).toFixed(2)}`
  // Only render a safe http(s) pay link; never inject an arbitrary scheme.
  const safePayUrl = /^https?:\/\//i.test(inv.payUrl) ? inv.payUrl : ''
  const rows = (inv.lineItems || []).map(l => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(l.name)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${Number(l.quantity || 0)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${money(l.unitPrice)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">${money(l.lineTotal)}</td>
        </tr>`).join('')
  const due = (() => { const d = new Date(inv.dueDate); return isNaN(d.getTime()) ? '' : d.toLocaleDateString() })()

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Invoice ${escapeHtml(inv.invoiceNumber)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2e;">
  <div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a1f2e;color:white;padding:24px;">
      <h1 style="margin:0 0 4px;color:#f97316;font-size:24px;">Invoice ${escapeHtml(inv.invoiceNumber)}</h1>
      <p style="margin:0;color:#94a3b8;font-size:14px;">From ${escapeHtml(fromName)}</p>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(inv.customerName)},</p>
      ${inv.introNote ? `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">${escapeHtml(inv.introNote)}</p>` : `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Here's your invoice for <strong>${escapeHtml(inv.jobTypeName)}</strong>.</p>`}

      ${rows ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px;">
          <thead><tr style="border-bottom:2px solid #e2e8f0;text-align:left;">
            <th style="padding:8px;">Item</th>
            <th style="padding:8px;text-align:right;">Qty</th>
            <th style="padding:8px;text-align:right;">Unit $</th>
            <th style="padding:8px;text-align:right;">Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : ''}

      <div style="background:#1a1f2e;color:white;padding:20px;border-radius:8px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#cbd5e1;">Subtotal</span><span style="font-weight:600;">${money(inv.subtotal)}</span></div>
        ${inv.amountPaid && inv.amountPaid > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#cbd5e1;">Already paid</span><span style="font-weight:600;">− ${money(inv.amountPaid)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:12px 0 0;border-top:2px solid #f97316;margin-top:8px;align-items:center;">
          <span style="color:#fb923c;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Amount Due</span>
          <span style="color:#f97316;font-size:28px;font-weight:700;">${money(inv.amountDue)}</span>
        </div>
        ${due ? `<div style="margin-top:8px;color:#94a3b8;font-size:13px;text-align:right;">Due by ${escapeHtml(due)}</div>` : ''}
      </div>

      ${safePayUrl ? `<div style="text-align:center;margin:0 0 20px;">
        <a href="${safePayUrl}" style="display:inline-block;background:#f97316;color:white;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;">View &amp; Pay Invoice →</a>
        <p style="font-size:12px;color:#94a3b8;margin:10px 0 0;">Or copy this link: ${escapeHtml(safePayUrl)}</p>
      </div>` : ''}

      ${inv.paymentTerms ? `<pre style="background:#f8fafc;padding:12px;border-radius:6px;font-family:inherit;font-size:13px;white-space:pre-wrap;margin:0 0 20px;">${escapeHtml(inv.paymentTerms)}</pre>` : ''}

      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0 0 8px;">Reply to this email with any questions about your invoice.</p>
      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0;">Thank you,<br/><strong style="color:#1a1f2e;">${escapeHtml(fromName)}</strong></p>
    </div>
  </div>
</body></html>`
}

export const sendInvoiceEmail = onCall<SendInvoiceCallPayload>(
  {
    secrets: [CLERK_SECRET_KEY, RESEND_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendInvoiceCallPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to || !input?.invoice) throw new HttpsError('invalid-argument', 'Missing email or invoice data')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new HttpsError('invalid-argument', 'Invalid email address')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`sendInvoiceEmail user=${userId} to=${input.to} inv=${input.invoice.invoiceNumber}`)

    const html = renderInvoiceEmailHtml(input)
    const subject = input.subject
      || `Invoice ${input.invoice.invoiceNumber} from ${input.fromName || input.invoice.businessName || 'Your Contractor'}`

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: EMAIL_DOMAIN_VERIFIED
            ? `${input.fromName || input.invoice.businessName || 'BuildPro+'} <alerts@builderspro.cc>`
            : EMAIL_FROM,
          to: [input.to],
          subject,
          html,
          ...(input.replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.replyTo) ? { reply_to: input.replyTo } : {}),
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('Resend invoice send failed', res.status, errText)
        throw new HttpsError('internal', `Email send failed: ${res.status}`)
      }
      const data = await res.json() as { id?: string }
      return { ok: true, emailId: data.id }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('sendInvoiceEmail error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `Email send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Change Order AI generator
// Same Claude brain as the main quote generator, with the same NC pricing
// + labor rules + shed knowledge. Just produces a simpler output: a
// description, reason category, and itemized line items.
// ──────────────────────────────────────────────────────────────────────────

interface GenerateChangeOrderInput {
  customerName: string
  jobTypeName: string          // The project this change order is on
  jobLocationZip?: string
  originalTotal: number        // For context — AI knows the baseline price
  description: string          // What the user wants the change order to be about
  hourlyRateOverride?: number
}

interface GenerateChangeOrderPayload {
  clerkToken: string
  input: GenerateChangeOrderInput
}

const CHANGE_ORDER_SYSTEM_PROMPT = `You are a senior general contractor in central North Carolina drafting a change order on an existing project.

Your job: given a brief description of what changed, produce a clean, customer-ready change order with itemized line items.

Output requirements:
- description: A short, professional 1-2 sentence summary of what changed (customer-facing). Use clear plain English.
- reason: One of 'customer_requested', 'site_condition', 'code_requirement', or 'other' — pick whichever fits best.
- line_items: An array of itemized changes. Each line:
    - name: a clear item or labor description
    - quantity: positive number for additions, NEGATIVE for credits/removals
    - unit_price: dollar amount per unit
    - line_total: quantity × unit_price (NEGATIVE for credits)
- contractor_notes: private notes about risks, install considerations, or things to verify on site. Not shown to the customer.

CHANGE ORDER PRICING RULES:
- Use NC fair-market pricing (see reference prices below). Do NOT pad.
- A change order should reflect the actual delta — material upcharges, additional labor hours, or credits for items removed.
- If the customer is UPGRADING (e.g. ceramic → subway tile), include BOTH the credit for the original material AND the charge for the new one. Use a negative line for the credit.
- If the customer wants to ADD scope (e.g. "also paint the closet"), itemize materials + labor for just that addition.
- If they want to REMOVE scope, all line items should be negative (credit back to customer).
- Labor: use $65/hr NC default unless the contractor specifies otherwise. Be realistic — small change orders should be 1-3 hours of labor, not 10.

${NC_PRICING_GUIDANCE}

${NC_LABOR_GUIDANCE}

ARITHMETIC RULE: quantity × unit_price = line_total. Negative quantity gives negative line_total (a credit).`

function buildChangeOrderUserPrompt(input: GenerateChangeOrderInput): string {
  const rateLine = input.hourlyRateOverride && input.hourlyRateOverride > 0
    ? `Contractor's hourly rate: $${input.hourlyRateOverride}/hour (use this for any labor line items).`
    : `No hourly rate override — use $65/hour NC default for labor.`

  return `Existing project: ${input.jobTypeName} for ${input.customerName}
Original project total: $${input.originalTotal.toFixed(2)}
Location: ZIP ${input.jobLocationZip || '(not specified — assume central NC)'}
${rateLine}

WHAT CHANGED (contractor's description):
${input.description}

Generate the structured change order. Itemize materials and labor separately. Use negative quantities for credits.`
}

export const generateChangeOrder = onCall<GenerateChangeOrderPayload>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as GenerateChangeOrderPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.customerName || !input?.description) {
      throw new HttpsError('invalid-argument', 'Missing customer name or change description')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`generateChangeOrder user=${userId} job=${input.jobTypeName}`)

    // NOTE: Change orders are FREE for all tiers. Only Quick Quotes (the two
    // estimate generators) count against the 10 free generations.

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    try {
      return await withAnthropicRetry('generateChangeOrder', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 4000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: changeOrderSchema },
          },
          system: CHANGE_ORDER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildChangeOrderUserPrompt(input) }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      // No quota refund here — change orders don't consume a credit (free for all).
      if (err instanceof HttpsError) throw err
      console.error('Change order generation failed after retries', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Thank-You Letter generator for project completion
// Returns a short, warm, customer-facing letter that gets bound with the
// project photo slideshow into a single PDF the contractor can print or share.
// ──────────────────────────────────────────────────────────────────────────

interface ThankYouInput {
  customerName: string
  jobTypeName: string
  jobLocationZip?: string
  contractorName?: string
  contractorBusiness?: string
  highlights?: string  // Optional notes from the contractor about what stood out
}

interface ThankYouPayload {
  clerkToken: string
  input: ThankYouInput
}

const THANK_YOU_SYSTEM_PROMPT = `You are writing a brief, warm, professional thank-you letter from a contractor to a customer at the completion of a project.

Output a JSON object with these exact fields:
- greeting: A short greeting line. E.g. "Dear Sarah," or "Hi Mike,". Use the customer's first name if possible.
- opening: ONE sentence thanking them for the opportunity to work on their project. If a business name is provided in the user prompt, weave it naturally into this opening sentence — e.g. "Thank you for choosing [BusinessName] for your kitchen remodel." When no business name is given, use a personal opening like "Thank you for letting me handle your kitchen remodel."
- body: TWO short paragraphs (3-5 sentences each):
    1) A warm reflection on the work — what was satisfying, any standout moments, the customer's role in making it go smoothly. Include ONE light, tasteful touch of humor somewhere in this paragraph — a friendly, good-natured line that fits a tradesman talking to a customer (e.g. a gentle joke about the weather, the coffee, the dog supervising the job, or how good it feels to finally see it finished). Keep it warm and human, never crude or sarcastic. Just one — don't force jokes throughout.
    2) Reassure them about quality and the photos enclosed. You MUST include a clear satisfaction-guarantee line in the contractor's voice: that you take pride in customer satisfaction, you stand behind your work, and if ANYTHING about the project bothers them for any reason, they should call so you can make it right. Express that you hope they enjoy the finished project as much as you enjoyed building it the way they envisioned. If a business name is provided, you may reference it once more here.
- closing: A short closing line ("With appreciation," / "Sincerely," / "Thank you again,") on its own line, followed by the contractor's name (use EXACTLY the name given in the user prompt — never invent one) on the next line, then the business name on a third line if provided. If no contractor name is given, use just the closing line and business name. Use real newlines between each. Format example (placeholders — substitute the real values from the user prompt):
    With appreciation,
    [Contractor Name]
    [Business Name]

Tone:
- Genuine and human, not corporate. A little warmth and ONE light, tasteful joke are welcome — it should read like a real, likable tradesman wrote it, not a template.
- Professional but not stiff — like a respected tradesman writing a personal note.
- 200-250 words total across the body. Customer-facing.
- No bullet lists, no headings, no markdown. Just clean prose.
- If a business name is given, treat it as the brand name customers should remember — say it 1-2 times max so it's prominent but not pushy.

CRITICAL — CONTRACTOR NOTES: If the user prompt includes a "MUST INCLUDE — contractor's notes" section, you MUST naturally weave EVERY point from those notes into the body of the letter. These are specific things the contractor explicitly asked you to mention (e.g. a detail about the job, a compliment to the customer, a callback offer). Do not ignore, summarize away, or omit any of them — they are required content. Work them in smoothly so the letter still reads naturally.

The output goes onto a printed PDF alongside a slideshow of project photos.`

interface ThankYouLetter {
  greeting: string
  opening: string
  body: string
  closing: string
}

const thankYouSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    greeting: { type: 'string' },
    opening: { type: 'string' },
    body: { type: 'string' },
    closing: { type: 'string' },
  },
  required: ['greeting', 'opening', 'body', 'closing'],
} as const

export const generateThankYouLetter = onCall<ThankYouPayload>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    // Opus 4.8 with medium effort is a bit slower than Sonnet — give headroom.
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as ThankYouPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.customerName || !input?.jobTypeName) {
      throw new HttpsError('invalid-argument', 'Missing customer name or job type')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`generateThankYouLetter user=${userId} customer=${input.customerName}`)

    // Pro-ONLY feature — a premium perk for paying contractors. Free users are
    // blocked here (it doesn't consume a quote credit; it's simply Pro-gated).
    await requireProOrThrow(userId, 'thankYouLetter')

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    const userPrompt = `Customer: ${input.customerName}
Job: ${input.jobTypeName}
${input.jobLocationZip ? `Location: ZIP ${input.jobLocationZip}\n` : ''}${input.contractorName ? `Signed by: ${input.contractorName}${input.contractorBusiness ? ` (${input.contractorBusiness})` : ''}\n` : ''}${input.highlights ? `\n=== MUST INCLUDE — contractor's notes (weave ALL of these into the letter, do not omit any) ===\n${input.highlights}\n=== end contractor's notes ===\n` : ''}
Write the thank-you letter.`

    try {
      return await withAnthropicRetry('generateThankYouLetter', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 2000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: thankYouSchema },
          },
          system: THANK_YOU_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text) as ThankYouLetter
      })
    } catch (err) {
      // No quota refund — thank-you letters are Pro-gated, not quota-consuming.
      if (err instanceof HttpsError) throw err
      console.error('Thank-you letter generation failed', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Proposal letter. Wraps a finished estimate in a warm, professional proposal
// the customer receives as their FIRST piece of paperwork — so the first thing
// they see reads like a real proposal, not a bare parts list. The estimate
// breakdown (scope, materials, totals, deposit, e-sign) still lives below it on
// the customer page; this just produces the cover letter that frames it.
//
// NOT Pro-gated and NOT quota-consuming — it's part of the standard send flow,
// and a cheap/fast text call. The client generates it ONCE on first send and
// caches the result on the estimate doc, so re-opening/printing never re-spends.
// If this call fails, the client falls back to a clean template so sending the
// customer's paperwork is NEVER blocked by an AI hiccup.
// ──────────────────────────────────────────────────────────────────────────

interface ProposalInput {
  customerName: string
  jobTypeName: string
  workScope?: string          // the work_scope / scope-of-work text
  customerSummary?: string    // the AI customer_summary, if present
  total?: number
  depositRequested?: boolean
  depositAmount?: number
  proposedStartDate?: string  // ISO date or free text, if the contractor set one
  jobLocationZip?: string
  businessName?: string
  contractorName?: string
  licenseNumber?: string
}

interface ProposalPayload {
  clerkToken: string
  input: ProposalInput
}

interface ProposalLetter {
  greeting: string
  intro: string
  approach: string
  included: string
  not_included: string
  timeline: string
  warranty: string
  closing: string
}

const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    greeting: { type: 'string' },
    intro: { type: 'string' },
    approach: { type: 'string' },
    included: { type: 'string' },
    not_included: { type: 'string' },
    timeline: { type: 'string' },
    warranty: { type: 'string' },
    closing: { type: 'string' },
  },
  required: ['greeting', 'intro', 'approach', 'included', 'not_included', 'timeline', 'warranty', 'closing'],
} as const

const PROPOSAL_SYSTEM_PROMPT = `You are a seasoned general contractor writing a professional PROPOSAL letter to a customer, based on an estimate you've already prepared. This is the first formal document the customer receives, so it must read warm, confident, and professional — like a respected tradesman who runs a real business, not a template and not a robot.

Output a JSON object with these EXACT fields (all required, all customer-facing prose, NO markdown, NO bullet symbols unless noted):

- greeting: A short greeting line using the customer's first name if possible. E.g. "Dear Mr. Smith," or "Hi Sarah,".
- intro: ONE short paragraph (2-3 sentences) thanking them for the opportunity to bid their project and introducing this as your proposal for the work. If a business name is given, weave it in naturally (e.g. "Thank you for the opportunity to bid your bathroom remodel — we at [Business] are pleased to present this proposal.").
- approach: ONE paragraph (3-5 sentences) describing HOW you will actually perform and handle the job, in plain, confident language. Walk them through the real sequence of work based on the scope provided (e.g. protect the space, demo, rough-in, install, finish, clean up). Make it specific to THIS job using the scope details — not generic filler.
- included: A clear list of what the price covers. Begin with the line "This proposal includes:" then 3-6 short items each on its own line starting with "• ". Base these on the scope and materials (e.g. all labor and materials listed, haul-away and cleanup). Be accurate to the job; do not invent things not in the scope.
- not_included: A brief, polite list of common exclusions so expectations are clear. Begin with the line "Not included:" then 2-4 short items each on its own line starting with "• " (e.g. unforeseen structural or code issues discovered during work, changes to the agreed scope which would be quoted separately). Keep it fair and standard — never adversarial.

PERMIT RULE (strict): Do NOT mention permits, permit fees, permitting, or pulling permits ANYWHERE in this letter UNLESS the scope/summary text provided below explicitly mentions permits. Many customers prefer the topic never be raised — if the estimate itself doesn't bring up permits, neither do you. The word "permit" must not appear in your output unless it appears in the provided scope.
- timeline: ONE or two sentences on how long the work takes and when it can begin. If a proposed start date is given, reference it. If not, give a reasonable working estimate for a job of this scope and note that the schedule will be confirmed together. Always include a gentle "weather permitting / barring unforeseen conditions" type caveat where appropriate.
- warranty: ONE or two sentences stating that you stand behind your work with a workmanship warranty and that if anything isn't right, the customer should reach out and you'll make it right. Confident and reassuring, not legalistic.
- closing: A short closing line ("Sincerely," / "We look forward to working with you," / "Respectfully,") on its own line, then the contractor's name (use EXACTLY the name given — never invent one) on the next line, then the business name on a third line if provided, then the license number prefixed with "Lic. " on a fourth line if provided. Use real newlines between each. If no contractor name is given, use just the closing line plus business name/license.

Tone: professional, confident, warm, trustworthy. Reads like a real contractor wrote it personally. Keep the whole thing tight — this frames an estimate that appears right below it, so don't repeat the line-item pricing here. Refer to the total/deposit only in passing if at all (the estimate shows the numbers).`

export const generateProposal = onCall<ProposalPayload>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    // Opus 4.8 with medium effort is a bit slower than Sonnet — give headroom.
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as ProposalPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.customerName || !input?.jobTypeName) {
      throw new HttpsError('invalid-argument', 'Missing customer name or job type')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`generateProposal user=${userId} customer=${input.customerName}`)

    // Not gated and not quota-consuming — part of the standard send flow.
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    const startLine = input.proposedStartDate
      ? `Proposed start date: ${input.proposedStartDate}\n`
      : ''
    const depositLine = input.depositRequested && (input.depositAmount || 0) > 0
      ? `A deposit of $${(input.depositAmount || 0).toFixed(2)} is requested before work begins.\n`
      : ''
    const userPrompt = `Customer: ${input.customerName}
Job: ${input.jobTypeName}
${input.jobLocationZip ? `Location: ZIP ${input.jobLocationZip}\n` : ''}${input.total ? `Total quoted: $${input.total.toFixed(2)}\n` : ''}${depositLine}${startLine}${input.businessName ? `Business: ${input.businessName}\n` : ''}${input.contractorName ? `Contractor name (sign exactly this): ${input.contractorName}\n` : ''}${input.licenseNumber ? `License #: ${input.licenseNumber}\n` : ''}
${input.customerSummary ? `=== Customer summary of the job ===\n${input.customerSummary}\n` : ''}
=== Scope of work (base the approach + included items on THIS) ===
${input.workScope || '(no detailed scope provided — write a sensible professional approach for this job type)'}

Write the proposal letter.`

    try {
      return await withAnthropicRetry('generateProposal', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 2500,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: proposalSchema },
          },
          system: PROPOSAL_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text) as ProposalLetter
      })
    } catch (err) {
      // No quota to refund. Sending must never be blocked, so the CLIENT has a
      // template fallback — we just surface the error for it to catch.
      if (err instanceof HttpsError) throw err
      console.error('Proposal generation failed', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Invoice copywriting (intro + payment terms)
// Line items + totals come from project data on the client side — this just
// produces the friendly cover text. Cheap + fast Claude call.
// ──────────────────────────────────────────────────────────────────────────

interface InvoiceCopyInput {
  customerName: string
  jobTypeName: string
  businessName?: string
  contractorName?: string
  total: number
  amountPaid?: number
  dueInDays?: number
  paymentMethods?: string  // e.g. "check, Venmo, Zelle, cash"
}

const invoiceCopySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro_note: { type: 'string' },
    payment_terms: { type: 'string' },
  },
  required: ['intro_note', 'payment_terms'],
} as const

const INVOICE_COPY_SYSTEM_PROMPT = `You are writing the cover text for a contractor invoice. Output:
- intro_note: ONE warm but professional sentence introducing the invoice. Reference the job type naturally. If a business name is provided, sign on behalf of it.
- payment_terms: ONE short paragraph (2-3 sentences) covering:
    - Payment due date (use the dueInDays value, default 14 days)
    - Accepted payment methods (use paymentMethods if provided, otherwise default to "check, Venmo, Zelle, or cash")
    - A brief courtesy line about reaching out with questions
Tone: professional, friendly, brief. Customer-facing. No markdown.`

export const generateInvoiceCopy = onCall<{ clerkToken: string; input: InvoiceCopyInput }>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    // Opus 4.8 with medium effort is a bit slower than Sonnet — give headroom.
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? {} as { clerkToken: string; input: InvoiceCopyInput }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.customerName) throw new HttpsError('invalid-argument', 'Missing customer name')

    const userId = await verifyClerk(clerkToken)
    console.log(`generateInvoiceCopy user=${userId} customer=${input.customerName}`)

    // NOTE: Invoice cover notes are FREE for all tiers. Only Quick Quotes count
    // against the 10 free generations.

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
    const prompt = `Customer: ${input.customerName}
Job: ${input.jobTypeName}
Total: $${input.total.toFixed(2)}
${input.amountPaid && input.amountPaid > 0 ? `Already paid (deposit): $${input.amountPaid.toFixed(2)}\nAmount due: $${(input.total - input.amountPaid).toFixed(2)}\n` : ''}Due in: ${input.dueInDays ?? 14} days
${input.paymentMethods ? `Payment methods: ${input.paymentMethods}\n` : ''}${input.businessName ? `Business: ${input.businessName}\n` : ''}${input.contractorName ? `Contractor: ${input.contractorName}\n` : ''}
Write the invoice cover text.`

    try {
      return await withAnthropicRetry('generateInvoiceCopy', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 1500,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: invoiceCopySchema },
          },
          system: INVOICE_COPY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text) as { intro_note: string; payment_terms: string }
      })
    } catch (err) {
      // No quota refund — invoice cover notes don't consume a credit (free for all).
      if (err instanceof HttpsError) throw err
      console.error('Invoice copy generation failed', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// parseCalendarEntry — voice "Quick Add" on the dashboard. The contractor taps
// the mic, says something like "add a job for the Miller bathroom next Tuesday
// at 9am" or "remind me to order tile on the 15th", and we turn that spoken
// sentence into a structured calendar entry. FREE for all tiers (tiny call).
// ──────────────────────────────────────────────────────────────────────────
const calendarEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // What kind of thing it is.
    kind: { type: 'string', enum: ['job', 'event', 'reminder'] },
    // A short, clean title (no date/time words baked in).
    title: { type: 'string' },
    // ISO date yyyy-mm-dd the entry belongs on. ALWAYS resolved to a real date.
    date: { type: 'string' },
    // 24h time "HH:MM" if the speaker gave one, else empty string.
    time: { type: 'string' },
    // Any extra detail worth keeping, else empty string.
    notes: { type: 'string' },
    // True only if we couldn't confidently figure out a date (caller will ask).
    needsDate: { type: 'boolean' },
  },
  required: ['kind', 'title', 'date', 'time', 'notes', 'needsDate'],
} as const

export const parseCalendarEntry = onCall<{ clerkToken: string; input: { transcript: string; todayISO: string } }>(
  {
    secrets: [ANTHROPIC_API_KEY, CLERK_SECRET_KEY],
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? {} as { clerkToken: string; input: { transcript: string; todayISO: string } }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const transcript = (input?.transcript || '').trim()
    if (!transcript) throw new HttpsError('invalid-argument', 'Nothing was said')
    // today's date drives relative phrases ("tomorrow", "next Tuesday"). The
    // client sends its LOCAL today so the math matches the contractor's timezone.
    const todayISO = /^\d{4}-\d{2}-\d{2}$/.test(input?.todayISO || '') ? input.todayISO : new Date().toISOString().slice(0, 10)

    const userId = await verifyClerk(clerkToken)
    console.log(`parseCalendarEntry user=${userId} transcript="${transcript.slice(0, 120)}"`)

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })
    const prompt = `Today's date is ${todayISO} (yyyy-mm-dd). The day of week of today is ${new Date(todayISO + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })}.

A contractor spoke this to quickly add something to their work calendar:
"""
${transcript}
"""

Turn it into a single calendar entry:
- kind: "job" if it's actual work for a customer; "reminder" if they said "remind me…" or it's a to-do; otherwise "event".
- title: a short clean label, WITHOUT the date or time words in it (e.g. "Miller bathroom", "Order tile", "Inspection at 123 Oak").
- date: resolve ANY relative phrase to a real yyyy-mm-dd using today's date above. "tomorrow" = today+1. "next Tuesday" = the Tuesday of next week. "the 15th" = the 15th of the current month (or next month if the 15th already passed). If they truly gave no date, set needsDate=true and put today's date in date as a placeholder.
- time: if they gave a time ("9am", "at 2:30"), convert to 24h "HH:MM". If no time, empty string "".
- notes: anything extra worth keeping; else "".
- needsDate: true ONLY if no date could be determined at all.`

    try {
      return await withAnthropicRetry('parseCalendarEntry', async () => {
        const stream = client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: calendarEntrySchema },
          },
          system: 'You convert a contractor\'s spoken sentence into one structured calendar entry. Be literal and accurate about dates — always output a real yyyy-mm-dd. Output JSON only.',
          messages: [{ role: 'user', content: prompt }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'No content returned. Please try again.')
        }
        return JSON.parse(textBlock.text) as {
          kind: 'job' | 'event' | 'reminder'; title: string; date: string; time: string; notes: string; needsDate: boolean
        }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('parseCalendarEntry failed', err)
      throw new HttpsError('unavailable', friendlyAnthropicError(err))
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Stripe — customer pays an invoice by card.
// createInvoiceCheckout: public (no Clerk) because the CUSTOMER calls it from
// the public /inv/<id> page. We trust only the invoiceId and read the amount
// from Firestore server-side — never from the client — so the amount can't be
// tampered with. Returns a Stripe-hosted Checkout URL.
// stripeWebhook: Stripe calls this after payment; we verify the signature and
// flip the invoice to paid. This is the source of truth, not the redirect.
// ──────────────────────────────────────────────────────────────────────────

interface InvoiceDoc {
  customerName?: string
  customerEmail?: string
  invoiceNumber?: string
  jobTypeName?: string
  amountDue?: number
  status?: 'draft' | 'sent' | 'paid' | 'overdue'
  createdBy?: string   // the contractor who owns this invoice — money routes to them
}

// Platform fee taken off the top of every customer card payment, to cover the
// cost of running the platform. Taken via Stripe application_fee so it's routed
// to OUR platform account automatically on every payment — guaranteed every
// time. The contractor keeps the rest. Because the charge sets `on_behalf_of`
// the contractor (see createInvoiceCheckout), the contractor is the merchant of
// record and Stripe's own processing fee is debited from THEM, not us — so this
// 2% is clean platform margin, not eaten by Stripe fees.
const PLATFORM_FEE_PERCENT = 2

// Called by the PUBLIC estimate page right after a customer approves an
// estimate that requested a deposit. Creates the deposit invoice SERVER-SIDE
// (so amounts are read from the estimate doc, never trusted from the client)
// and returns its id so the customer can pay immediately. Idempotent: if the
// deposit invoice already exists, it returns the existing one.
export const createDepositInvoiceForApproval = onRequest(
  { cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
    const estimateId = (req.body?.estimateId ?? '') as string
    // payFull=true → create an invoice for the WHOLE job instead of the deposit
    // (customer chose to pay it all upfront). Amount is still read server-side.
    const payFull = req.body?.payFull === true
    if (!estimateId) { res.status(400).json({ error: 'Missing estimateId' }); return }
    try {
      const db = getAdminDb()
      const estRef = db.collection('estimates').doc(estimateId)
      const estSnap = await estRef.get()
      if (!estSnap.exists) { res.status(404).json({ error: 'Estimate not found' }); return }
      const est = estSnap.data() as Record<string, unknown>

      // Only for genuinely approved estimates that requested a deposit.
      if (est.status !== 'approved' || !est.depositRequested || !(Number(est.depositAmount) > 0)) {
        res.status(400).json({ error: 'No deposit due for this estimate.' })
        return
      }
      const ownerId = est.createdBy as string | undefined
      const projectId = est.projectId as string | undefined
      if (!ownerId) { res.status(400).json({ error: 'Estimate missing owner.' }); return }

      // Idempotency: reuse an existing deposit/full invoice for this project.
      if (projectId) {
        const existing = await db.collection('invoices')
          .where('createdBy', '==', ownerId)
          .where('projectId', '==', projectId)
          .where('isDeposit', '==', true)
          .limit(1).get()
        if (!existing.empty) {
          // If they previously made a deposit invoice but now want to pay full,
          // bump that same invoice to the full amount so we don't duplicate.
          const exDoc = existing.docs[0]
          const exData = exDoc.data() as Record<string, unknown>
          const fullAmt = +Number(est.total || 0).toFixed(2)
          if (payFull && exData.status !== 'paid' && Number(exData.subtotal) !== fullAmt) {
            await exDoc.ref.set({ subtotal: fullAmt, amountDue: fullAmt, payFull: true }, { merge: true })
          }
          res.json({ invoiceId: exDoc.id }); return
        }
      }

      const deposit = +Number(est.depositAmount).toFixed(2)
      const jobTotal = +Number(est.total || 0).toFixed(2)
      const balance = +Math.max(0, jobTotal - deposit).toFixed(2)
      const jobTypeName = (est.jobTypeName as string) || 'Project'
      const scope = ((est.scopeOfWork as string) || (est.description as string) || jobTypeName).trim()
      // What we actually bill on this invoice: deposit, or the full job.
      const billAmount = payFull ? jobTotal : deposit

      // Pull contractor branding from their user doc.
      const userSnap = await db.collection('users').doc(ownerId).get()
      const u = (userSnap.data() as Record<string, unknown>) || {}

      // Invoice number: count this owner's invoices this year.
      const invSnap = await db.collection('invoices').where('createdBy', '==', ownerId).get()
      const year = new Date().getFullYear()
      const sameYear = invSnap.docs.filter(d => {
        const c = d.data().createdAt as string
        return c && new Date(c).getFullYear() === year
      }).length
      const invoiceNumber = `INV-${year}-${String(sameYear + 1).padStart(4, '0')}`

      const payload: Record<string, unknown> = {
        ...(projectId ? { projectId } : {}),
        customerName: (est.customerName as string) || 'Customer',
        jobTypeName: payFull ? jobTypeName : `${jobTypeName} — Deposit`,
        invoiceNumber,
        introNote: payFull
          ? `Thank you for approving your ${jobTypeName.toLowerCase()}. This invoice is for the full job, paid upfront.`
          : `Thank you for approving your ${jobTypeName.toLowerCase()}. This invoice is for the deposit to schedule and begin the work.`,
        paymentTerms: payFull
          ? `WORK ORDER\n${scope}\n\nPAYMENT\n• Full job paid upfront: $${jobTotal.toFixed(2)}\n\nWork begins once payment is received.`
          : `WORK ORDER\n${scope}\n\nPAYMENT TERMS\n` +
            `• Total job: $${jobTotal.toFixed(2)}\n` +
            `• Deposit due now: $${deposit.toFixed(2)}\n` +
            `• Balance due at completion: $${balance.toFixed(2)}\n\n` +
            `Work begins once the deposit is received.`,
        lineItems: payFull
          ? [{ name: `${jobTypeName} — paid in full`, quantity: 1, unitPrice: jobTotal, lineTotal: jobTotal }]
          : [{ name: `Deposit to begin work — ${jobTypeName}`, quantity: 1, unitPrice: deposit, lineTotal: deposit }],
        subtotal: billAmount,
        amountPaid: 0,
        amountDue: billAmount,
        payFull,
        status: 'sent',
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isDeposit: true,
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
        ...(est.jobLocationZip ? { jobLocationZip: est.jobLocationZip } : {}),
        ...(u.businessName ? { businessName: u.businessName } : {}),
        ...(u.businessPhone ? { businessPhone: u.businessPhone } : {}),
        ...(u.businessEmail ? { businessEmail: u.businessEmail } : {}),
        ...(u.licenseNumber ? { licenseNumber: u.licenseNumber } : {}),
        ...(u.logoUrl ? { logoUrl: u.logoUrl } : {}),
      }
      const ref = await db.collection('invoices').add(payload)
      // Flag the estimate so the dashboard sweep doesn't also create one.
      await estRef.set({ depositInvoiceCreated: true }, { merge: true })
      res.json({ invoiceId: ref.id })
    } catch (err) {
      console.error('createDepositInvoiceForApproval failed', err)
      res.status(500).json({ error: 'Could not prepare your deposit invoice. Please try again.' })
    }
  },
)

export const createInvoiceCheckout = onRequest(
  { secrets: [STRIPE_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
    const invoiceId = (req.body?.invoiceId ?? '') as string
    if (!invoiceId) { res.status(400).json({ error: 'Missing invoiceId' }); return }

    try {
      const db = getAdminDb()
      const snap = await db.collection('invoices').doc(invoiceId).get()
      if (!snap.exists) { res.status(404).json({ error: 'Invoice not found' }); return }
      const inv = snap.data() as InvoiceDoc

      if (inv.status === 'paid') { res.status(409).json({ error: 'This invoice is already paid.' }); return }
      const amountDue = Number(inv.amountDue ?? 0)
      if (!(amountDue > 0)) { res.status(400).json({ error: 'Nothing is due on this invoice.' }); return }

      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const returnUrl = `${PUBLIC_HOST}/inv/${invoiceId}`
      // Amount is read from Firestore server-side (never from the client) and
      // converted to integer cents — this is the only source for what's charged.
      const amountCents = Math.round(amountDue * 100)

      // Route the money to the CONTRACTOR's connected account (Stripe Connect),
      // taking our 2% platform fee off the top. The contractor must have
      // finished payout setup (connectPayoutsEnabled) — if not, the public page
      // shouldn't have shown "Pay by Card", but we double-check here so money
      // never has nowhere valid to land.
      let connectAccountId: string | undefined
      if (inv.createdBy) {
        const ownerSnap = await db.collection('users').doc(inv.createdBy).get()
        const owner = ownerSnap.data() as { stripeConnectId?: string; connectPayoutsEnabled?: boolean } | undefined
        if (owner?.stripeConnectId && owner.connectPayoutsEnabled) {
          connectAccountId = owner.stripeConnectId
        }
      }
      if (!connectAccountId) {
        res.status(409).json({ error: 'This contractor hasn\'t finished setting up card payouts yet. Please pay by cash, or contact them.' })
        return
      }
      const feeCents = Math.round(amountCents * (PLATFORM_FEE_PERCENT / 100))

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        // Omit payment_method_types so Stripe shows dynamic payment methods.
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: `Invoice ${inv.invoiceNumber ?? ''}`.trim(),
              description: `${inv.jobTypeName ?? 'Services'} — ${inv.customerName ?? ''}`.trim(),
            },
          },
        }],
        ...(inv.customerEmail ? { customer_email: inv.customerEmail } : {}),
        success_url: returnUrl,
        cancel_url: returnUrl,
        // Stamped onto the webhook event so we know which invoice to mark paid.
        metadata: { invoiceId },
        payment_intent_data: {
          metadata: { invoiceId },
          // 2% off the top → our platform; remainder → the contractor.
          application_fee_amount: feeCents,
          // The contractor is the merchant of record: their business shows on the
          // customer's statement and Stripe's processing fee is debited from the
          // contractor (not the platform), so our 2% application fee is clean
          // margin. The charge itself is still created on the platform account,
          // so checkout.session.completed fires on the platform and the existing
          // webhook marks the invoice paid — no Connect webhook needed.
          on_behalf_of: connectAccountId,
          transfer_data: { destination: connectAccountId },
        },
      }, {
        // Idempotency: keying on invoiceId + current amount means rapid repeat
        // clicks (or two open tabs) reuse the SAME checkout session instead of
        // creating duplicates that could each be paid. A legitimate new amount
        // (after an edit) produces a new key, so re-billing still works.
        idempotencyKey: `inv_${invoiceId}_${amountCents}`,
      })

      await snap.ref.set({ stripeSessionId: session.id }, { merge: true })
      res.json({ url: session.url })
    } catch (err) {
      console.error('createInvoiceCheckout failed', err)
      res.status(500).json({ error: 'Could not start checkout. Please try again.' })
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Stripe — contractor subscribes to BuildPro+ Pro ($19.99/mo).
// These are onCall (the CONTRACTOR is signed in via Clerk). We create/reuse a
// Stripe Customer per user, then either start a subscription Checkout or open
// the Customer Portal. The webhook (below) flips users/{id}.tier on/off based
// on subscription lifecycle events — webhook is the source of truth.
// ──────────────────────────────────────────────────────────────────────────

// Get the user's existing Stripe customer id, or create one and persist it.
async function getOrCreateStripeCustomer(stripe: InstanceType<typeof StripeLib>, userId: string, email?: string): Promise<string> {
  const db = getAdminDb()
  const userRef = db.collection('users').doc(userId)
  const snap = await userRef.get()
  const existing = (snap.data() as { stripeCustomerId?: string } | undefined)?.stripeCustomerId
  if (existing) {
    // Verify the saved customer still exists in the CURRENT Stripe mode. Early
    // accounts may carry a TEST-mode customer id from before we went live; in
    // live mode that lookup fails. If so, fall through and create a fresh one.
    try {
      const c = await stripe.customers.retrieve(existing)
      if (c && !(c as { deleted?: boolean }).deleted) return existing
    } catch {
      console.warn(`Stale/unknown Stripe customer ${existing} for ${userId} — recreating in current mode`)
    }
  }
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    metadata: { clerkUserId: userId },
  })
  await userRef.set({ stripeCustomerId: customer.id }, { merge: true })
  return customer.id
}

// ──────────────────────────────────────────────────────────────────────────
// Stripe CONNECT — so contractors can RECEIVE card payments from THEIR
// customers directly into their own bank. We use Express connected accounts:
// the contractor does a short Stripe-hosted onboarding (bank/debit + the
// legally-required identity info) without ever seeing a Stripe dashboard.
// Money from a customer's card goes straight to the contractor's connected
// account; we take a 2% application fee off the top automatically.
//
// The connected account id + payout-ready status live on users/{id} as
// SERVER-ONLY fields (stripeConnectId, connectPayoutsEnabled) — the client can
// never write them (enforced by Firestore rules), only read them.
// ──────────────────────────────────────────────────────────────────────────

// Get the contractor's existing connected account id, or create one.
async function getOrCreateConnectAccount(stripe: InstanceType<typeof StripeLib>, userId: string, email?: string): Promise<string> {
  const db = getAdminDb()
  const userRef = db.collection('users').doc(userId)
  const snap = await userRef.get()
  const existing = (snap.data() as { stripeConnectId?: string } | undefined)?.stripeConnectId
  if (existing) return existing
  const account = await stripe.accounts.create({
    type: 'express',
    ...(email ? { email } : {}),
    business_type: 'individual',
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { clerkUserId: userId },
  })
  await userRef.set({ stripeConnectId: account.id }, { merge: true })
  return account.id
}

// startConnectOnboarding: contractor taps "Set up payouts". Returns a Stripe
// Account Link URL we send them to; on completion Stripe redirects back to the
// app. We refresh status from Stripe (don't trust the redirect alone).
export const startConnectOnboarding = onCall<{ clerkToken: string; email?: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken, email } = request.data ?? {} as { clerkToken: string; email?: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)
    try {
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const accountId = await getOrCreateConnectAccount(stripe, userId, email)
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${PUBLIC_HOST}/?payouts=refresh`,
        return_url: `${PUBLIC_HOST}/?payouts=done`,
        type: 'account_onboarding',
      })
      return { url: link.url }
    } catch (err) {
      console.error('startConnectOnboarding failed', err)
      const msg = err instanceof Error ? err.message : 'Could not start payout setup.'
      // Surface Stripe's "Connect not enabled" message clearly to the owner.
      throw new HttpsError('internal', msg)
    }
  },
)

// createConnectAccountSession: returns a short-lived client_secret for an
// EMBEDDED onboarding component, so the bank/identity form renders RIGHT INSIDE
// our app (no redirect to a Stripe page). The frontend mounts it with
// @stripe/react-connect-js. This is the "feels native" payout setup.
export const createConnectAccountSession = onCall<{ clerkToken: string; email?: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken, email } = request.data ?? {} as { clerkToken: string; email?: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)
    try {
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const accountId = await getOrCreateConnectAccount(stripe, userId, email)
      const accountSession = await stripe.accountSessions.create({
        account: accountId,
        components: {
          account_onboarding: { enabled: true },
        },
      })
      return { clientSecret: accountSession.client_secret }
    } catch (err) {
      console.error('createConnectAccountSession failed', err)
      const msg = err instanceof Error ? err.message : 'Could not start payout setup.'
      throw new HttpsError('internal', msg)
    }
  },
)

// getConnectStatus: read the contractor's payout readiness from Stripe and cache
// it on their user doc. Returns whether they can accept card payments yet.
export const getConnectStatus = onCall<{ clerkToken: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken } = request.data ?? {} as { clerkToken: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)
    try {
      const db = getAdminDb()
      const userRef = db.collection('users').doc(userId)
      const connectId = (await userRef.get()).data()?.stripeConnectId as string | undefined
      if (!connectId) return { connected: false, payoutsEnabled: false, detailsSubmitted: false }

      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const acct = await stripe.accounts.retrieve(connectId)
      const payoutsEnabled = !!acct.charges_enabled && !!acct.payouts_enabled
      // Cache for quick reads (e.g. gating the public Pay-by-Card button).
      await userRef.set({ connectPayoutsEnabled: payoutsEnabled, connectDetailsSubmitted: !!acct.details_submitted }, { merge: true })
      return { connected: true, payoutsEnabled, detailsSubmitted: !!acct.details_submitted }
    } catch (err) {
      console.error('getConnectStatus failed', err)
      throw new HttpsError('internal', 'Could not check payout status.')
    }
  },
)

export const createSubscriptionCheckout = onCall<{ clerkToken: string; email?: string; plan?: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken, email, plan } = request.data ?? {} as { clerkToken: string; email?: string; plan?: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)

    try {
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const customerId = await getOrCreateStripeCustomer(stripe, userId, email)
      const returnUrl = `${PUBLIC_HOST}/?billing=`
      // monthly ($19.99/mo) by default; 'quarterly' = $49.99 every 3 months;
      // 'yearly' = $159.99/yr all access.
      const priceId = priceIdForPlan(plan)
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${returnUrl}success`,
        cancel_url: `${returnUrl}cancel`,
        // Let customers enter a promotion code (e.g. the yearly 20%-off codes).
        // Codes are restricted in Stripe (min order $159.99) so they only apply
        // to the yearly plan; entering one on monthly/quarterly is rejected.
        allow_promotion_codes: true,
        // Stamp the user so the webhook can map the subscription back to them.
        subscription_data: { metadata: { clerkUserId: userId } },
        metadata: { clerkUserId: userId },
      })
      return { url: session.url }
    } catch (err) {
      console.error('createSubscriptionCheckout failed', err)
      throw new HttpsError('internal', 'Could not start subscription checkout.')
    }
  },
)

// Pay-as-you-go: buy a pack of instant-quote credits at $1 each (1–10). A
// one-time Checkout; the webhook adds `quantity` to paidQuoteCredits on success.
// For people who don't want a subscription — a few bucks gets them going.
export const createQuotePackCheckout = onCall<{ clerkToken: string; email?: string; quantity?: number }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken, email, quantity } = request.data ?? {} as { clerkToken: string; email?: string; quantity?: number }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)
    // Clamp to 1–10 server-side so the amount can never be tampered with.
    const qty = Math.max(1, Math.min(10, Math.round(Number(quantity) || 1)))

    try {
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const customerId = await getOrCreateStripeCustomer(stripe, userId, email)
      const returnUrl = `${PUBLIC_HOST}/?credits=`
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        line_items: [{
          quantity: qty,
          price_data: {
            currency: 'usd',
            unit_amount: 100, // $1.00 each
            product_data: { name: 'BuildPro+ instant quote', description: 'One instant quote credit' },
          },
        }],
        success_url: `${returnUrl}success`,
        cancel_url: `${returnUrl}cancel`,
        // The webhook reads these to credit the right user the right amount.
        metadata: { clerkUserId: userId, quoteCredits: String(qty) },
        payment_intent_data: { metadata: { clerkUserId: userId, quoteCredits: String(qty) } },
      })
      return { url: session.url }
    } catch (err) {
      console.error('createQuotePackCheckout failed', err)
      throw new HttpsError('internal', 'Could not start checkout.')
    }
  },
)

export const createPortalSession = onCall<{ clerkToken: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken } = request.data ?? {} as { clerkToken: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)

    try {
      const db = getAdminDb()
      const snap = await db.collection('users').doc(userId).get()
      const data = snap.data() as { stripeCustomerId?: string; businessEmail?: string } | undefined
      if (!data?.stripeCustomerId) throw new HttpsError('failed-precondition', 'No subscription to manage yet.')
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      // Self-heal: if the saved customer id is stale (e.g. a test-mode id from
      // before going live), getOrCreateStripeCustomer recreates a valid one.
      const customerId = await getOrCreateStripeCustomer(stripe, userId, data.businessEmail)
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${PUBLIC_HOST}/`,
      })
      return { url: portal.url }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('createPortalSession failed', err)
      // Pass Stripe's specific reason through so it's diagnosable (e.g. "portal
      // configuration not set up", "No such customer").
      const msg = (err as { raw?: { message?: string } })?.raw?.message
        || (err instanceof Error ? err.message : 'Could not open the billing portal.')
      throw new HttpsError('internal', msg)
    }
  },
)

export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], cors: false, timeoutSeconds: 30 },
  async (req, res) => {
    const sig = req.headers['stripe-signature']
    if (!sig) { res.status(400).send('Missing signature'); return }

    const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
    let event: ReturnType<typeof stripe.webhooks.constructEvent>
    try {
      // rawBody is required for signature verification — Firebase provides it.
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value())
    } catch (err) {
      console.error('Stripe webhook signature verification failed', err)
      res.status(400).send('Invalid signature')
      return
    }

    try {
      const db = getAdminDb()

      // Flip a user's tier based on their Stripe subscription. Keeps Pro until
      // the period ends on cancellation; drops to free on a dead subscription.
      const applySubscriptionStatus = async (sub: {
        id: string
        status: string
        metadata?: Record<string, string> | null
        cancel_at_period_end?: boolean | null
        current_period_end?: number | null
        items?: { data?: Array<{ current_period_end?: number | null }> } | null
      }) => {
        const userId = sub.metadata?.clerkUserId
        if (!userId) {
          console.warn('Subscription event without clerkUserId metadata', sub.id)
          return
        }
        // "active" or "trialing" = Pro. "canceled"/"unpaid"/"incomplete_expired"
        // = free. Stripe keeps status "active" until period end even when the
        // user has set cancel_at_period_end, so "keep Pro until period ends" is
        // handled automatically by Stripe's own status timing.
        //
        // DELIBERATE: 'past_due' is NOT in proStatuses. When a card declines on
        // renewal, the user immediately drops to free until Stripe successfully
        // retries (Stripe's smart retry kicks the sub back to 'active', firing
        // another webhook that restores Pro). This is stricter than Stripe's
        // grace-period default, but it prevents free-riding during the retry
        // window. To soften, add 'past_due' to proStatuses.
        const proStatuses = ['active', 'trialing']
        const isPro = proStatuses.includes(sub.status)

        // ── ACCESS CUTOFF DATE (Stripe's real paid-through date) ──
        // current_period_end is the unix-seconds timestamp that this paid period
        // runs through — i.e. the date access is good until. Stripe pushes it
        // FORWARD automatically every time a renewal payment succeeds (monthly →
        // next calendar month, 3-month → +3 months, yearly → +1 year), and never
        // moves it on a failed/cancelled sub. We store it (ms) so the app can show
        // "Pro access through <date>" and so access has a concrete end even if a
        // later webhook is ever missed. Newer Stripe API versions expose the field
        // on the subscription item rather than the subscription, so we read both.
        const periodEndSec = sub.current_period_end
          ?? sub.items?.data?.[0]?.current_period_end
          ?? null
        const periodEndMs = periodEndSec ? periodEndSec * 1000 : null

        await db.collection('users').doc(userId).set({
          tier: isPro ? 'pro' : 'free',
          subscriptionStatus: sub.status,
          stripeSubscriptionId: sub.id,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          // Only overwrite the cutoff when Stripe gave us a fresh one, so a
          // sparse event can't wipe a known-good date.
          ...(periodEndMs ? { subscriptionCurrentPeriodEnd: periodEndMs } : {}),
        }, { merge: true })
        console.log(`User ${userId} tier=${isPro ? 'pro' : 'free'} (sub ${sub.status}) through ${periodEndMs ? new Date(periodEndMs).toISOString() : 'n/a'}`)
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          // Subscription signup → grant Pro immediately (don't wait for the
          // separate subscription.created event). Idempotent by nature: a
          // duplicate webhook delivery just re-writes the same tier:'pro' (no-op);
          // the customer.subscription.* events are the authoritative source of truth.
          if (session.mode === 'subscription') {
            const userId = session.metadata?.clerkUserId
            if (userId) {
              await db.collection('users').doc(userId).set({
                tier: 'pro',
                subscriptionStatus: 'active',
                ...(typeof session.subscription === 'string' ? { stripeSubscriptionId: session.subscription } : {}),
              }, { merge: true })
              console.log(`User ${userId} upgraded to Pro via checkout`)
            }
            break
          }
          // Pay-as-you-go quote pack ($1 each) → add credits to the buyer.
          const quoteCredits = Number(session.metadata?.quoteCredits ?? 0)
          if (quoteCredits > 0 && session.payment_status === 'paid') {
            const buyerId = session.metadata?.clerkUserId
            if (buyerId) {
              // Idempotency: record handled session ids so a duplicate webhook
              // delivery doesn't double-credit.
              const sessRef = db.collection('processedCreditSessions').doc(session.id)
              const already = await sessRef.get()
              if (already.exists) {
                console.log(`Quote-pack session ${session.id} already processed — skipping`)
                break
              }
              await db.collection('users').doc(buyerId).set({
                paidQuoteCredits: FieldValue.increment(quoteCredits),
              }, { merge: true })
              await sessRef.set({ at: new Date().toISOString(), userId: buyerId, credits: quoteCredits })
              console.log(`Added ${quoteCredits} quote credit(s) to ${buyerId}`)
            }
            break
          }
          // Otherwise it's a one-time invoice payment.
          const invoiceId = session.metadata?.invoiceId
          if (invoiceId && session.payment_status === 'paid') {
            const invRef = db.collection('invoices').doc(invoiceId)
            const invSnap = await invRef.get()
            // Idempotency: Stripe guarantees AT-LEAST-once delivery, so we'll
            // sometimes get the same paid event twice. Skip if already paid so
            // we don't overwrite the original paidAt timestamp or re-fire the
            // project-close logic.
            const currentStatus = (invSnap.data() as InvoiceDoc | undefined)?.status
            if (currentStatus === 'paid') {
              console.log(`Invoice ${invoiceId} already marked paid — skipping duplicate webhook event`)
              break
            }
            await invRef.set({
              status: 'paid',
              amountDue: 0,
              paidAt: new Date().toISOString(),
              paidAtMs: Date.now(),   // numeric anchor for the 2-year retention lock
              stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
            }, { merge: true })
            console.log(`Invoice ${invoiceId} marked paid via Stripe`)

            // Auto-advance the project to "closed" now that it's paid. Only move
            // forward from completed → closed; never knock a project backward.
            const projectId = (invSnap.data() as { projectId?: string } | undefined)?.projectId
            if (projectId) {
              try {
                const projRef = db.collection('projects').doc(projectId)
                const projSnap = await projRef.get()
                const status = (projSnap.data() as { status?: string } | undefined)?.status
                if (status && status !== 'closed') {
                  await projRef.set({
                    status: 'closed',
                    closedAt: new Date().toISOString(),
                    notes: 'Invoice paid in full — project auto-closed.',
                  }, { merge: true })
                  console.log(`Project ${projectId} auto-closed (invoice paid)`)
                }
              } catch (projErr) {
                console.error('Could not auto-close project after payment', projErr)
              }
            }
          }
          break
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          await applySubscriptionStatus(event.data.object)
          break
        }
        // A contractor's CONNECT account changed (finished onboarding, payouts
        // enabled/disabled). Cache the payout-ready flag on their user doc so the
        // public Pay-by-Card button and checkout routing stay accurate.
        case 'account.updated': {
          const acct = event.data.object as { id?: string; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; metadata?: { clerkUserId?: string } }
          const uid = acct.metadata?.clerkUserId
          if (uid) {
            // Cross-check: the account id must match the one stored on this user,
            // so a confused/stale event can never flip the wrong user's payout flag.
            const storedConnectId = (await db.collection('users').doc(uid).get()).data()?.stripeConnectId as string | undefined
            if (storedConnectId && acct.id && storedConnectId !== acct.id) {
              console.warn(`account.updated id mismatch for ${uid}: event ${acct.id} != stored ${storedConnectId} — ignoring`)
              break
            }
            await db.collection('users').doc(uid).set({
              connectPayoutsEnabled: !!acct.charges_enabled && !!acct.payouts_enabled,
              connectDetailsSubmitted: !!acct.details_submitted,
            }, { merge: true })
            console.log(`Connect account.updated for ${uid}: payouts=${!!acct.charges_enabled && !!acct.payouts_enabled}`)
          }
          break
        }
        default:
          // Ignore other event types.
          break
      }
    } catch (err) {
      console.error('Stripe webhook handling failed', err)
      res.status(500).send('Handler error')
      return
    }

    res.json({ received: true })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// morningAgendaAlert — runs every day at 6:00 AM Eastern. For each contractor
// who has something on their calendar TODAY (a custom calendar event OR a
// project whose startDate is today), email them that day's agenda so a job
// never sneaks up on them. The in-app 6am notification (client-side) is the
// other half — this is the "works even when the app is closed" half.
//
// Sender uses the shared EMAIL_FROM (sandbox until builderspro.cc is verified,
// then alerts@builderspro.cc — flip EMAIL_DOMAIN_VERIFIED at the top of the file).
const ALERT_FROM = EMAIL_FROM

export const morningAgendaAlert = onSchedule(
  {
    schedule: '0 6 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY],
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    const db = getAdminDb()
    // Today's date in Eastern (the schedule's timezone) as yyyy-mm-dd.
    const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    console.log(`morningAgendaAlert running for ${todayISO}`)

    // Gather everything scheduled for today, grouped by owner.
    const byUser = new Map<string, { jobs: string[]; events: string[] }>()
    const bucket = (uid: string) => { if (!byUser.has(uid)) byUser.set(uid, { jobs: [], events: [] }); return byUser.get(uid)! }

    // Calendar events dated today.
    const evSnap = await db.collection('calendarEvents').where('date', '==', todayISO).get()
    evSnap.forEach(d => {
      const e = d.data() as { createdBy?: string; title?: string; time?: string; kind?: string }
      if (!e.createdBy) return
      const t = e.time ? ` at ${e.time}` : ''
      bucket(e.createdBy).events.push(`${e.kind === 'reminder' ? '🔔 ' : ''}${e.title || 'Event'}${t}`)
    })

    // Projects starting today. startDate may be a plain "yyyy-mm-dd" or a full
    // ISO timestamp, so range-match anything that BEGINS with today's date
    // (\uf8ff is a high code point — the standard Firestore starts-with trick).
    const projSnap = await db.collection('projects')
      .where('startDate', '>=', todayISO)
      .where('startDate', '<=', todayISO + '\uf8ff')
      .get()
    projSnap.forEach(d => {
      const p = d.data() as { createdBy?: string; archived?: boolean; declined?: boolean; status?: string; customerName?: string; jobTypeName?: string; startDate?: string }
      if (!p.createdBy || p.archived || p.declined || p.status === 'closed') return
      if (!(p.startDate || '').startsWith(todayISO)) return
      bucket(p.createdBy).jobs.push(`${p.jobTypeName || 'Job'} for ${p.customerName || 'customer'}`)
    })

    if (byUser.size === 0) { console.log('No agendas today; nothing to send.'); return }

    let sent = 0
    for (const [uid, agenda] of byUser) {
      try {
        // Find the contractor's email: profile businessEmail first.
        const uDoc = await db.collection('users').doc(uid).get()
        const u = (uDoc.data() as { businessEmail?: string; businessName?: string } | undefined) ?? {}
        const to = u.businessEmail
        if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { console.log(`Skip ${uid}: no valid email`); continue }

        const lines: string[] = []
        if (agenda.jobs.length) lines.push('<strong>Jobs today:</strong><ul>' + agenda.jobs.map(j => `<li>🔨 ${j}</li>`).join('') + '</ul>')
        if (agenda.events.length) lines.push('<strong>On your calendar:</strong><ul>' + agenda.events.map(e => `<li>📌 ${e}</li>`).join('') + '</ul>')
        const prettyDate = new Date(todayISO + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1f2e">
          <h2 style="color:#f97316;margin:0 0 4px">Good morning${u.businessName ? ', ' + escapeHtml(u.businessName) : ''} ☀️</h2>
          <p style="color:#64748b;margin:0 0 16px">Here's what you've got on for <strong>${prettyDate}</strong>:</p>
          ${lines.join('')}
          <p style="color:#94a3b8;font-size:12px;margin-top:20px">— BuildPro+ · Open the app: https://builderspro.cc</p>
        </div>`

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY.value()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: ALERT_FROM, to: [to], subject: `☀️ Today's schedule — ${prettyDate}`, html }),
        })
        if (res.ok) { sent++ } else { console.error(`Agenda email failed for ${uid}:`, res.status, await res.text()) }
      } catch (err) {
        console.error(`Agenda email error for ${uid}:`, err)
      }
    }
    console.log(`morningAgendaAlert done: ${sent} email(s) sent for ${todayISO}`)
  },
)

// ──────────────────────────────────────────────────────────────────────────
// "A customer responded" email alerts. When a customer approves/declines an
// estimate or change order, or pays an invoice, the contractor gets an email
// instantly — so they know even when the app is closed. These are Firestore
// triggers (fire the moment the doc changes), not tied to the app being open.
// ──────────────────────────────────────────────────────────────────────────

// Send a branded email to a contractor. Looks up their email from their user
// doc (businessEmail). No-op if they have no email on file.
async function emailContractor(ownerId: string | undefined, subject: string, bodyHtml: string): Promise<void> {
  if (!ownerId) return
  try {
    const db = getAdminDb()
    const u = (await db.collection('users').doc(ownerId).get()).data() as { businessEmail?: string; businessName?: string } | undefined
    const to = u?.businessEmail
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { console.log(`emailContractor: no valid email for ${ownerId}`); return }
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1f2e">
      <h2 style="color:#f97316;margin:0 0 12px">BuildPro+</h2>
      ${bodyHtml}
      <p style="color:#94a3b8;font-size:12px;margin-top:20px">Open the app: https://builderspro.cc</p>
    </div>`
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY.value()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    })
    if (!res.ok) console.error('emailContractor send failed', res.status, await res.text())
  } catch (err) {
    console.error('emailContractor error', err)
  }
}

// Estimate approved/declined → email the contractor.
export const onEstimateResponded = onDocumentUpdated(
  { document: 'estimates/{id}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data?.before.data() as { status?: string } | undefined
    const after = event.data?.after.data() as { status?: string; createdBy?: string; customerName?: string; jobTypeName?: string; total?: number; customerResponse?: { signedName?: string; reason?: string } } | undefined
    if (!after) return
    // Only fire on the FIRST transition into approved/declined (not later edits).
    const wasPending = before?.status === 'pending' || !before?.status
    if (!wasPending) return
    // Escape all customer/contractor-supplied strings before putting them in HTML.
    const name = escapeHtml(after.customerName || 'your customer')
    const job = escapeHtml(after.jobTypeName || 'job')
    if (after.status === 'approved') {
      await emailContractor(after.createdBy,
        `✅ ${after.customerName || 'A customer'} approved your estimate`,
        `<p style="font-size:15px">Good news — <strong>${name}</strong> just <strong>approved</strong> the ${job} estimate${after.total ? ` ($${Number(after.total).toLocaleString()})` : ''}.</p>
         <p style="font-size:14px;color:#64748b">Signed by ${escapeHtml(after.customerResponse?.signedName || after.customerName || 'the customer')}. It's now in your Projects, ready to go.</p>`)
    } else if (after.status === 'declined') {
      await emailContractor(after.createdBy,
        `${after.customerName || 'A customer'} declined your estimate`,
        `<p style="font-size:15px"><strong>${name}</strong> declined the ${job} estimate.</p>
         ${after.customerResponse?.reason ? `<p style="font-size:14px;color:#64748b">Reason: ${escapeHtml(after.customerResponse.reason)}</p>` : ''}
         <p style="font-size:14px;color:#64748b">You can adjust it and re-send anytime.</p>`)
    }
  },
)

// Change order approved/declined → email the contractor.
export const onChangeOrderResponded = onDocumentUpdated(
  { document: 'changeOrders/{id}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data?.before.data() as { status?: string } | undefined
    const after = event.data?.after.data() as { status?: string; createdBy?: string; customerName?: string; delta?: number; customerResponse?: { signedName?: string } } | undefined
    if (!after) return
    const wasPending = before?.status === 'pending' || !before?.status
    if (!wasPending) return
    const coName = escapeHtml(after.customerName || 'Your customer')
    if (after.status === 'approved') {
      await emailContractor(after.createdBy,
        `✅ ${after.customerName || 'A customer'} approved a change order`,
        `<p style="font-size:15px"><strong>${coName}</strong> approved a change order${after.delta != null ? ` (${after.delta >= 0 ? '+' : '−'}$${Math.abs(Number(after.delta)).toLocaleString()})` : ''}.</p>
         <p style="font-size:14px;color:#64748b">Your contract total has been updated in the project.</p>`)
    } else if (after.status === 'declined') {
      await emailContractor(after.createdBy,
        `${after.customerName || 'A customer'} declined a change order`,
        `<p style="font-size:15px"><strong>${coName}</strong> declined a change order.</p>`)
    }
  },
)

// Invoice paid (card) or customer chose cash → email the contractor.
export const onInvoicePaidAlert = onDocumentUpdated(
  { document: 'invoices/{id}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data?.before.data() as { status?: string; customerCashChoice?: boolean } | undefined
    const after = event.data?.after.data() as { status?: string; customerCashChoice?: boolean; createdBy?: string; customerName?: string; invoiceNumber?: string; subtotal?: number } | undefined
    if (!after) return
    const invName = escapeHtml(after.customerName || 'Your customer')
    const invNo = escapeHtml(after.invoiceNumber || '')
    // Paid by card: status flipped to 'paid'.
    if (before?.status !== 'paid' && after.status === 'paid') {
      await emailContractor(after.createdBy,
        `💳 ${after.customerName || 'A customer'} paid invoice ${after.invoiceNumber || ''}`.trim(),
        `<p style="font-size:15px">You got paid! <strong>${invName}</strong> paid invoice ${invNo}${after.subtotal ? ` ($${Number(after.subtotal).toLocaleString()})` : ''} by card.</p>
         <p style="font-size:14px;color:#64748b">The funds are on their way to your bank.</p>`)
      return
    }
    // Customer chose "Pay Cash / In Person".
    if (!before?.customerCashChoice && after.customerCashChoice) {
      await emailContractor(after.createdBy,
        `💵 ${after.customerName || 'A customer'} will pay cash for invoice ${after.invoiceNumber || ''}`.trim(),
        `<p style="font-size:15px"><strong>${invName}</strong> chose to pay invoice ${invNo}${after.subtotal ? ` ($${Number(after.subtotal).toLocaleString()})` : ''} in cash/in person.</p>
         <p style="font-size:14px;color:#64748b">Confirm it as paid in the app once you've collected.</p>`)
    }
  },
)
