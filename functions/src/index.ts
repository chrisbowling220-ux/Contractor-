// deploy-marker: stripe-live-v7 (confirm live price deployed)
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
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

// Where customers return after Stripe Checkout. The public invoice page lives
// at /inv/<id>; on return it re-reads the invoice (now marked paid by webhook).
const PUBLIC_HOST = 'https://contractors-office-96731.web.app'

// The $19.99/mo "BuildPro+ Pro" recurring price. Test-mode price ID for now;
// swap to the live price_... here when going live.
// LIVE-mode $19.99/mo BuildPro+ Pro price. Must be paired with the live
// sk_live_ secret key — a live price will NOT work with a test secret key.
const PRO_PRICE_ID = 'price_1Tbj8IKz3SO2ZkDQQ4gjBq9j'

// ──────────────────────────────────────────────────────────────────────────
// Subscription / usage gate
// Free tier: 5 AI quotes total. After that, AI features turn off until the
// user upgrades to the paid subscription (wired up in a later session).
// users/{userId} doc shape:
//   tier: 'free' | 'pro'
//   aiQuotesUsed: number
//   stripeCustomerId?: string
//   stripeSubscriptionId?: string
//   subscriptionStatus?: 'active' | 'past_due' | 'canceled' | ...
// ──────────────────────────────────────────────────────────────────────────

const FREE_TIER_AI_LIMIT = 5

interface UserDoc {
  tier?: 'free' | 'pro'
  aiQuotesUsed?: number
}

// Ensures the user's gate check passes BEFORE we burn an Anthropic call.
// Throws HttpsError('resource-exhausted') with a friendly message when the
// free tier is used up. Increments usage atomically on success.
async function consumeAiQuoteOrThrow(userId: string, featureName: string): Promise<{ tier: 'free' | 'pro'; used: number; remaining: number | null }> {
  const db = getAdminDb()
  const userRef = db.collection('users').doc(userId)
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(userRef)
    const data = (snap.data() as UserDoc | undefined) ?? {}
    const tier: 'free' | 'pro' = data.tier === 'pro' ? 'pro' : 'free'
    const used = data.aiQuotesUsed ?? 0

    if (tier === 'free' && used >= FREE_TIER_AI_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `You've used all ${FREE_TIER_AI_LIMIT} free AI generations. Upgrade to BuildPro+ Pro for unlimited.`,
      )
    }

    // Pro = unlimited. We still count usage for analytics/billing-debug, but
    // don't enforce a cap.
    tx.set(userRef, {
      tier,
      aiQuotesUsed: FieldValue.increment(1),
      lastAiAt: new Date().toISOString(),
    }, { merge: true })

    return {
      tier,
      used: used + 1,
      remaining: tier === 'pro' ? null : Math.max(0, FREE_TIER_AI_LIMIT - (used + 1)),
    }
  })
  console.log(`AI gate: user=${userId} feature=${featureName} tier=${result.tier} used=${result.used} remaining=${result.remaining}`)
  return result
}

// Refund one consumed credit when a generation fails AFTER the gate charged it,
// so a transient outage doesn't cost a free-tier user one of their 5 quotes.
// Never lets the counter go negative.
async function refundAiQuote(userId: string): Promise<void> {
  try {
    const db = getAdminDb()
    const userRef = db.collection('users').doc(userId)
    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef)
      const used = (snap.data() as UserDoc | undefined)?.aiQuotesUsed ?? 0
      if (used > 0) tx.set(userRef, { aiQuotesUsed: used - 1 }, { merge: true })
    })
  } catch (err) {
    console.error('AI credit refund failed for', userId, err)
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
  debugForceFail?: string
}

interface AnalyzeCallPayload {
  clerkToken: string
  input: AnalyzeScanInput
}

const NC_PRICING_GUIDANCE = `PRICING REGION: Use realistic 2026 retail pricing at the nearest Home Depot / Lowe's / regional supplier to the job's ZIP code. The job ZIP is provided in the user prompt — use it. Below is a NORTH CAROLINA BASELINE (central NC / Roxboro / Durham area). Adjust up or down from this baseline based on the actual job ZIP.

REGIONAL ADJUSTMENT GUIDELINES (apply to the NC baseline below):
- Coastal CA (901–921, 939–966): +25 to 35% on materials, +50% on labor rates.
- NYC metro (100–119): +30 to 40% on materials, +60% on labor.
- Boston / DC / Seattle / Bay Area metros: +20 to 30% on materials, +40 to 50% on labor.
- Major TX / FL metros (Austin, Houston, Miami, Tampa): +5 to 15% on materials, +20% on labor.
- Chicago / Denver / Phoenix / Atlanta metros: +5 to 10% on materials, +15 to 25% on labor.
- Rural Midwest, Appalachia, Deep South small towns: -5 to 10% on both materials and labor versus NC.
- Most of central / piedmont North Carolina (ZIPs 27xxx, 28xxx interior): use the baseline as-is.
- Alaska, Hawaii, remote islands: +40 to 60% on materials due to shipping; +30%+ on labor.
- If the ZIP is unusual or you can't place it, use the NC baseline and note the assumption in contractor_notes.

NORTH CAROLINA BASELINE PRICES (Home Depot / Lowe's, 2026, central NC retail — adjust as above):
- 1/2" Drywall 4x8 sheet: $15.98
- 2x4x8 SPF stud: $3.78
- 2x4x10 SPF stud: $5.48
- 1/2" CDX plywood 4x8: $36.98
- 7/16" OSB 4x8: $22.98
- Interior latex paint (Behr/Valspar, 1 gal): $31.98
- Primer (1 gal): $23.98
- Ceramic tile 12x12 (basic): $1.98/sqft
- Porcelain tile 12x24: $3.98/sqft
- Thinset (50lb bag): $17.98
- Sanded grout (10lb): $13.98
- Oak hardwood flooring: $5.48/sqft
- Laminate flooring: $1.79/sqft
- Luxury vinyl plank: $2.69/sqft
- Architectural shingles (33sqft bundle): $36.98
- R-13 batt insulation: $0.78/sqft
- R-19 batt insulation: $1.05/sqft
- 12/2 Romex w/ ground (250ft): $109.98
- 14/2 Romex w/ ground (250ft): $82.98
- Standard 15A outlet: $1.28
- Single pole switch: $1.78
- 1/2" PEX (100ft): $36.98
- Concrete mix (60lb bag): $5.48
- Joint compound (4.5 gal bucket): $17.97

For items not in the reference list, use realistic 2026 retail prices in the same spirit, adjusted for the job ZIP per the regional guidelines above. If the ZIP is in central NC, use the baseline as-is. If the ZIP is in a higher-cost or lower-cost region, scale appropriately.

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
- Do NOT pad. Do NOT inflate quantities to be "safe." An accurate, lean, honest material list wins the job and protects the contractor's reputation. Over-quoting loses customers.`

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

${SHED_KNOWLEDGE}

${ARITHMETIC_RULES}`

const ANALYZE_SYSTEM_PROMPT = `You are a senior general contractor doing a live walkthrough of a job site. You are looking at one or more photos of the space AND listening to the contractor's spoken narration about what work needs to be done. Your job is to produce a complete structured estimate from what you see and hear.

How to read the inputs:
- The images show the actual job site. Identify what is there: surface materials, fixtures, condition of walls/floors/ceilings, visible damage, obstacles, room dimensions if you can infer them from context.
- The transcript is the contractor talking out loud during the scan. It will be informal speech, possibly with fillers, repetition, and corrections. Extract the contractor's intent — what they say should be done, what materials they mention, what concerns they raise. The transcript is the primary source of TRUTH for scope; the images give physical context.
- If the transcript and images disagree, prioritize the transcript and flag the disagreement in contractor_notes.
- If room dimensions are not stated in the transcript and not inferable from images, make reasonable estimates (e.g. "approximately 10×12 ft based on visible fixtures") and note your assumptions in contractor_notes.

Material strategy:
- Generate a COMPLETE material list with realistic items, units, and 2026 retail unit prices at Home Depot / Lowe's (see reference prices below). Completeness is critical — see the COMPLETENESS rule in the pricing section. Include every consumable and incidental (fasteners, adhesives, caulk, primer, tape, underlayment, trim, fixtures, disposal) the job needs, not just the headline materials. Build the list as if walking the store aisles filling a cart to finish this exact job. Forgetting small items costs the contractor money — do not forget them.
- Apply per-material waste factors (tile 10–15%, drywall 10%, paint 5%, lumber 10%, flooring 8–10%, fasteners/incidentals 15%) — but ONLY to discrete whole units (sheets, studs, tiles, fixtures) where you buy whole and waste offcuts.
- RIGHT-SIZE divisible bulk consumables (see the RIGHT-SIZE rule in the pricing section): if the job uses half a can of paint, price 0.5 of a can — don't bill a full can. A small patch uses a cup of joint compound, not a whole bucket. Bill what's actually used. Do NOT pad or over-quote — accuracy wins the job.
- Show your quantity math explicitly in quantity_math, including any dimension assumptions and any fractional-use reasoning.

Labor and pricing:
- Estimate labor hours by phase based on the scope you inferred. Use the productivity benchmarks below — do NOT pad hours.
- Use a default hourly_rate of $65/hour (NC fair-market solo skilled tradesman) unless the transcript specifies otherwise.
- Recommend a markup appropriate to the raw cost tier (see labor guidance below). Small jobs cap at 15–20%.
- Prefer the LOWER end of labor hour ranges. Coverage for risk goes in the markup, not in inflated hours.

work_scope and customer_summary go directly in front of the customer. contractor_notes are private to the contractor and should flag risks, assumptions, and items needing field verification.

${NC_PRICING_GUIDANCE}

${NC_LABOR_GUIDANCE}

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

function friendlyAnthropicError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'AI service error. Please try again.'
  const e = err as { status?: number; error?: { type?: string; message?: string } }
  const type = e.error?.type
  if (type === 'overloaded_error' || e.status === 529) {
    return 'The AI service is busy right now. We retried but couldn\'t get through — please try again in a minute.'
  }
  if (type === 'rate_limit_error' || e.status === 429) {
    return 'AI rate limit hit. Please wait a moment and try again.'
  }
  if (e.status === 401) {
    return 'AI authentication failed — please contact support.'
  }
  if (e.status && e.status >= 500) {
    return 'AI service is having issues. Please try again shortly.'
  }
  return e.error?.message || 'AI quote generation failed. Please try again.'
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
    // if the user has used all 5. Atomic increment so concurrent calls
    // can't sneak past the limit. (Note: we burn the credit BEFORE the
    // call, so a failed AI call still counts. Could refund on retry later.)
    await consumeAiQuoteOrThrow(userId, 'quote')

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    try {
      return await withAnthropicRetry('generateAIQuote', async () => {
        if (input.debugForceFail) {
          console.log(`generateAIQuote: synthetic failure requested (${input.debugForceFail})`)
          throwSyntheticFailure(input.debugForceFail)
        }
        const stream = client.messages.stream({
          model: 'claude-opus-4-7',
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: aiQuoteSchema },
          },
          system: GENERATE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildGenerateUserPrompt(input) }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'Claude returned no text content')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      // The gate already charged a credit; refund it so a failure is free.
      await refundAiQuote(userId)
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
    // counts as one AI quote against the free tier.
    await consumeAiQuoteOrThrow(userId, 'quote')

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

Analyze the images and the contractor's narration together. Produce the structured quote document.`,
      },
    ]

    try {
      return await withAnthropicRetry('analyzeScan', async () => {
        if (input.debugForceFail) {
          console.log(`analyzeScan: synthetic failure requested (${input.debugForceFail})`)
          throwSyntheticFailure(input.debugForceFail)
        }
        const stream = client.messages.stream({
          model: 'claude-opus-4-7',
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: aiQuoteSchema },
          },
          system: ANALYZE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'Claude returned no text content')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      // The gate already charged a credit; refund it so a failure is free.
      await refundAiQuote(userId)
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
          from: `${input.fromName || 'Contractors Office'} <onboarding@resend.dev>`,
          to: [input.to],
          subject,
          html,
          reply_to: input.replyTo || undefined,
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

    // Free-tier gate — change orders count against the 5 free generations.
    await consumeAiQuoteOrThrow(userId, 'generation')

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    try {
      return await withAnthropicRetry('generateChangeOrder', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-7',
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
          throw new HttpsError('internal', 'Claude returned no text content')
        }
        return JSON.parse(textBlock.text)
      })
    } catch (err) {
      await refundAiQuote(userId)
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
    timeoutSeconds: 60,
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

    // Free-tier gate — thank-you letters count against the 5 free generations.
    await consumeAiQuoteOrThrow(userId, 'generation')

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() })

    const userPrompt = `Customer: ${input.customerName}
Job: ${input.jobTypeName}
${input.jobLocationZip ? `Location: ZIP ${input.jobLocationZip}\n` : ''}${input.contractorName ? `Signed by: ${input.contractorName}${input.contractorBusiness ? ` (${input.contractorBusiness})` : ''}\n` : ''}${input.highlights ? `\n=== MUST INCLUDE — contractor's notes (weave ALL of these into the letter, do not omit any) ===\n${input.highlights}\n=== end contractor's notes ===\n` : ''}
Write the thank-you letter.`

    try {
      return await withAnthropicRetry('generateThankYouLetter', async () => {
        const stream = client.messages.stream({
          model: 'claude-opus-4-7',
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
          throw new HttpsError('internal', 'Claude returned no text content')
        }
        return JSON.parse(textBlock.text) as ThankYouLetter
      })
    } catch (err) {
      await refundAiQuote(userId)
      if (err instanceof HttpsError) throw err
      console.error('Thank-you letter generation failed', err)
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
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? {} as { clerkToken: string; input: InvoiceCopyInput }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.customerName) throw new HttpsError('invalid-argument', 'Missing customer name')

    const userId = await verifyClerk(clerkToken)
    console.log(`generateInvoiceCopy user=${userId} customer=${input.customerName}`)

    // Free-tier gate — invoice copy counts against the 5 free generations.
    await consumeAiQuoteOrThrow(userId, 'generation')

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
          model: 'claude-opus-4-7',
          max_tokens: 1500,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: invoiceCopySchema },
          },
          system: INVOICE_COPY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        })
        const message = await stream.finalMessage()
        const textBlock = message.content.find(b => b.type === 'text')
        if (!textBlock || textBlock.type !== 'text') {
          throw new HttpsError('internal', 'Claude returned no text content')
        }
        return JSON.parse(textBlock.text) as { intro_note: string; payment_terms: string }
      })
    } catch (err) {
      await refundAiQuote(userId)
      if (err instanceof HttpsError) throw err
      console.error('Invoice copy generation failed', err)
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
}

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
        payment_intent_data: { metadata: { invoiceId } },
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
  if (existing) return existing
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    metadata: { clerkUserId: userId },
  })
  await userRef.set({ stripeCustomerId: customer.id }, { merge: true })
  return customer.id
}

export const createSubscriptionCheckout = onCall<{ clerkToken: string; email?: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken, email } = request.data ?? {} as { clerkToken: string; email?: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)

    try {
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const customerId = await getOrCreateStripeCustomer(stripe, userId, email)
      const returnUrl = `${PUBLIC_HOST}/?billing=`
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: PRO_PRICE_ID, quantity: 1 }],
        success_url: `${returnUrl}success`,
        cancel_url: `${returnUrl}cancel`,
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

export const createPortalSession = onCall<{ clerkToken: string }>(
  { secrets: [STRIPE_SECRET_KEY, CLERK_SECRET_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    const { clerkToken } = request.data ?? {} as { clerkToken: string }
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    const userId = await verifyClerk(clerkToken)

    try {
      const db = getAdminDb()
      const snap = await db.collection('users').doc(userId).get()
      const customerId = (snap.data() as { stripeCustomerId?: string } | undefined)?.stripeCustomerId
      if (!customerId) throw new HttpsError('failed-precondition', 'No subscription to manage yet.')
      const stripe = new StripeLib(STRIPE_SECRET_KEY.value())
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${PUBLIC_HOST}/`,
      })
      return { url: portal.url }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('createPortalSession failed', err)
      throw new HttpsError('internal', 'Could not open the billing portal.')
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
        await db.collection('users').doc(userId).set({
          tier: isPro ? 'pro' : 'free',
          subscriptionStatus: sub.status,
          stripeSubscriptionId: sub.id,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        }, { merge: true })
        console.log(`User ${userId} tier=${isPro ? 'pro' : 'free'} (sub ${sub.status})`)
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          // Subscription signup → grant Pro immediately (don't wait for the
          // separate subscription.created event). The webhook reconciles later.
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
