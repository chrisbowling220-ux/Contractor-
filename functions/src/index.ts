import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { verifyToken } from '@clerk/backend'
import Anthropic from '@anthropic-ai/sdk'
import { SpeechClient } from '@google-cloud/speech'
import { aiQuoteSchema, ARITHMETIC_RULES } from './aiQuoteSchema'

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')
const CLERK_SECRET_KEY = defineSecret('CLERK_SECRET_KEY')
const RESEND_API_KEY = defineSecret('RESEND_API_KEY')
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID')
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN')
const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER')

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

For items not in the reference list, use realistic 2026 retail prices in the same spirit, adjusted for the job ZIP per the regional guidelines above. If the ZIP is in central NC, use the baseline as-is. If the ZIP is in a higher-cost or lower-cost region, scale appropriately.`

const FASTENER_PRICING = `FASTENER & SCREW PRICING — Lowe's Published List Prices (2026, verify before quoting as prices vary by region):

DRYWALL SCREWS (coarse thread, bugle head, Phillips drive):
- #6 × 1 in    — $5.98 / box of 289  (~$0.021/pc) | use for 1/4" drywall to metal
- #6 × 1-1/4 in — $6.98 / box of 245  (~$0.028/pc) | most common single-layer drywall
- #6 × 1-5/8 in — $6.98 / box of 189  (~$0.037/pc) | double-layer or 5/8" drywall
- #6 × 1-1/4 in — $24.98 / 5-lb box of 1190 (~$0.021/pc) | bulk, medium jobs
- #6 × 1-5/8 in — $24.98 / 5-lb box of 945  (~$0.026/pc) | bulk, medium jobs
- #6 × 1-1/4 in — $49.98 / 25-lb box of 6125 (~$0.008/pc) | bulk, large jobs

WOOD & CONSTRUCTION SCREWS (Star/Torx drive unless noted):
- #8 × 1-5/8 in — $10.48 / 153-ct (~$0.068/pc) | interior framing, light structural
- #8 × 2 in     — $10.48 / 129-ct (~$0.081/pc) | interior framing
- #10 × 3 in    — $10.48 / 73-ct  (~$0.144/pc) | heavy structural, treated lumber

DECK & EXTERIOR SCREWS (Star/Torx drive):
- Deck Plus #10 × 2-1/2 in — $29.98 / 365-ct (~$0.082/pc) | standard deck boards
- Deck Plus #10 × 3 in     — $10.98 / 62-ct  (~$0.177/pc) | small packs
- Deck Plus #10 × 3 in     — $29.98 / 310-ct (~$0.097/pc) | medium jobs
- DeckForce #10 × 3 in     — $29.98 / 316-ct (~$0.095/pc) | alternative brand
- Deck Plus #10 × 3 in     — $59.98 / 5-lb 800-ct (~$0.075/pc) | bulk deck projects

SPECIALTY SCREWS:
- Interior trim screw, yellow zinc #9 × 3 in     — $10.48 / 72-ct (~$0.146/pc) | finish trim work
- Power Pro exterior epoxy #10 × 3 in             — $12.98 / 70-ct (~$0.185/pc) | high-exposure exterior
- Simpson Strong-Tie SD #9 × 1-1/2 in (mech-galv) — $15.98 / 100-ct (~$0.160/pc) | structural connectors

FASTENER USAGE RULES (apply these when building material lists):
- Drywall: buy bulk 5-lb or 25-lb boxes for any job over 10 sheets; use per-piece price for estimates but quote the nearest box size
- Decking: use 8–10 screws per 8-ft deck board for 5/4 boards, 6–8 for 2x6; add 10% waste
- Framing: use #10 × 3 in for PT lumber connections, #8 × 2 in for interior 2x4 framing
- Always quote the most cost-effective pack size for the job volume
- Source: Lowe's online list pricing — note that in-store pricing and regional pricing may differ slightly`

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

const CONTRACTOR_BRAIN_PATTERNS = `CONTRACTOR'S MINDSET — Think like you've built and remodeled for 20+ years. Apply these patterns to every job:

LOOK BEYOND THE OBVIOUS — what's implied but not said
- Water stains or damage → what caused it? Is there mold behind the substrate? Is the subfloor compromised? A tile replacement that hides rot is a callback waiting to happen. Flag in contractor_notes.
- Old bathroom fixtures → assume shutoff valves and supply lines are original and corroded. Replace them while you're in there — cheap insurance ($10–20/line). Include in material_list.
- "Just paint" jobs → what's the wall condition? Cracks, texture, sheen mismatch, and trim gaps are customer-visible failures. Proper prep (scraping, patching, priming, caulking trim) is 40% of a paint job.
- Tile removal → what's under it? Mud bed? Green board? Drywall? Mud bed adds demo time. Wet drywall is a change order. Flag the unknowns.
- Pre-1980 home → asbestos in floor tile/mastic, lead paint on trim. EPA RRP Rule applies for disturbing >6 sqft of painted surface in a pre-1978 home. Certified contractor required. Note in contractor_notes if home age is unknown or likely pre-1980.

WHAT ALWAYS COMES WITH COMMON JOB TYPES (include these unless transcript explicitly excludes them)
- Any tile work: backer board or waterproofing membrane where required, transition strips at doorways, caulk at inside corners (never grout), expansion joints on large fields, sealer after grout.
- Bathroom remodel: GFCI outlets required by code within 6 ft of water source, adequate vent fan (50 CFM minimum), shutoff valve replacement, supply line replacement.
- Any demo: debris disposal (estimate cubic yards; 1 pickup truck load = ~2 cu yd), dust containment if occupied home, floor protection on travel paths.
- Drywall work: priming before paint, texture matching if textured walls exist (flag: texture matching is hard), corner bead on outside corners.
- Flooring install: subfloor inspection and repair first, transition strips at every doorway, baseboard removal and reinstall or shoe mold to cover gap.
- Exterior paint: power wash + dry time (24–48 hrs), scrape and prime bare wood, caulk all seams and trim joints, 2 finish coats minimum.
- Electrical work: permit required if new circuits, breaker panel assessment, wire gauge matching existing circuits.

SITE LOGISTICS — always think through these
- Debris removal: where does it go? Dumpster? Contractor haul? Include disposal labor/cost for any demo job. A standard 10-yd dumpster in NC: ~$350–450 delivered.
- Staging area: where do materials land? Second-floor job = more labor (add 15–20% labor time for material handling). No elevator in multi-story = factor accordingly.
- Occupied home: dust containment required (plastic sheeting, zipper doors); working hours limited (8 AM–6 PM); protect floors on travel path.
- Water shutoff: any plumbing job needs a plan for shutting off water and restoring it same day if customer lives there.
- Access constraints: narrow doorways, HOA rules, shared driveways, parking restrictions — flag any that affect material delivery or equipment.

TRADE SEQUENCING — get the order right, or you'll be tearing out finished work
- Rough-in (plumbing/electric) → inspections → waterproofing/substrate → tile/finish → fixtures/trim → paint last.
- Never set tile over questionable substrate. Never paint over unfixed drywall. Never install cabinets before flooring (unless floating floor goes under them — note it).
- Multi-visit jobs: explain visit sequence in work_scope so customer understands why it's not one continuous day of work (cure times, inspection windows, etc.).

COMMON GOTCHAS — always flag relevant ones in contractor_notes
- "While we're in there" scope creep: get full scope locked in writing before starting. Change orders cost more than getting it right upfront.
- Matching existing materials: matching existing tile, stain color, or paint sheen is HARD and sometimes impossible. Set expectations early.
- Hidden conditions disclaimer: this quote covers visible scope. Rot, mold, or structural damage found during demo is a change order. Include this language in contractor_notes.
- Permit timeline: in NC, permit approval can take 1–5 business days. Inspections add 1–3 days each. Factor into project timeline.
- Special-order materials: custom tile, specialty fixtures, or lead-time items can delay the entire project 2–6 weeks. Confirm availability before signing contract.

WHAT TO FLAG IN CONTRACTOR_NOTES (private, not customer-facing)
- All assumptions about dimensions, hidden conditions, or scope that couldn't be confirmed from photos/transcript.
- Items that will become a change order if conditions differ from expected.
- Code compliance items that may require permit (electrical, structural, plumbing changes).
- Questions the contractor needs to ask the customer before finalizing the quote.
- Risk items: old home, prior water damage, complex access, matching existing work.`

const GENERATE_SYSTEM_PROMPT = `You are a senior general contractor in central North Carolina producing a structured estimate document for a customer job. You think like someone who has run hundreds of jobs — you know what's implied by a scope description, what always gets missed, and what will come back as a callback if you cut corners on the estimate.

Your job:
- Write professional, customer-friendly prose for the customer-facing sections.
- Apply realistic, material-specific waste factors to every material quantity (typical: tile 10–15%, drywall 10%, paint 5%, lumber 10%, flooring 8–10%, fasteners/incidentals 15%).
- Estimate labor hours and break them down by phase if the job has multiple phases.
- Include the materials and tasks that ALWAYS come with this type of job, even if not explicitly stated (e.g., transition strips, backer board, shutoff valve replacement, debris disposal).
- Recommend a profit markup appropriate to the job's risk and complexity (typical small remodel: 20–35% on top of raw cost; new construction lower, complex specialty work higher).
- Be honest about what is and is not included.
- Keep work_scope structured with short headings and short lines so it is scannable.
- contractor_notes are private — flag risks, hidden-condition assumptions, code requirements, and callouts the contractor needs before running the job. Do not duplicate customer-facing text there.

${NC_PRICING_GUIDANCE}

${FASTENER_PRICING}

${NC_LABOR_GUIDANCE}

${SHED_KNOWLEDGE}

${CONTRACTOR_BRAIN_PATTERNS}

${ARITHMETIC_RULES}`

const ANALYZE_SYSTEM_PROMPT = `You are a senior general contractor doing a live walkthrough of a job site. You are looking at one or more photos of the space AND listening to the contractor's spoken narration about what work needs to be done. You think like someone who has run hundreds of jobs — you know what the photos are telling you beyond the obvious, what the contractor probably meant even when they weren't precise, and what always gets missed in a verbal scope.

Your job is to produce a complete, realistic, field-tested estimate from what you see and hear.

How to read the inputs:
- The images show the actual job site. Identify surface materials, fixtures, condition of walls/floors/ceilings, visible damage, room dimensions (infer from fixtures/context if not stated), and any site conditions that affect labor or logistics.
- The transcript is the contractor talking out loud during the scan — informal, possibly with fillers and corrections. Extract the contractor's intent: what they want done, materials mentioned, concerns raised. The transcript is the PRIMARY source of scope truth; images provide physical context.
- If the transcript and images disagree, prioritize the transcript and note the discrepancy in contractor_notes.
- If dimensions are not stated and can't be inferred, make reasonable estimates (e.g., "approximately 10×12 ft based on visible fixtures") and document assumptions in contractor_notes.
- If the transcript includes "ADDITIONAL DETAILS" or refinement notes from a second pass, treat those as corrections and additions to the original scope — they take precedence over any earlier assumptions you might have made.

Material strategy:
- Generate a COMPLETE material list — including the materials that always come with this job type even if not explicitly mentioned (backer board, transition strips, shutoff valves, caulk, primer, disposal bags, etc.).
- Use realistic 2026 retail prices at Home Depot / Lowe's in the job's ZIP region.
- Apply per-material waste factors (tile 10–15%, drywall 10%, paint 5%, lumber 10%, flooring 8–10%, fasteners/incidentals 15%).
- Show quantity math explicitly in quantity_math, including dimension assumptions.

Labor and pricing:
- Estimate labor hours by phase based on inferred scope. Use the productivity benchmarks — do NOT pad hours.
- Include material handling, site prep, cleanup, and debris removal labor — not just installation time.
- Use a default hourly_rate of $65/hour (NC fair-market solo skilled tradesman) unless the transcript specifies otherwise.
- Recommend a markup appropriate to the raw cost tier. Small jobs cap at 15–20%.
- Prefer the LOWER end of labor hour ranges — markup and contingency cover risk, not inflated hours.

work_scope and customer_summary go directly in front of the customer. contractor_notes are private — flag risks, hidden-condition assumptions, permit requirements, and questions needing field verification before the job starts.

${NC_PRICING_GUIDANCE}

${FASTENER_PRICING}

${NC_LABOR_GUIDANCE}

${SHED_KNOWLEDGE}

${CONTRACTOR_BRAIN_PATTERNS}

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
          ${ai.profit_markup.markup_dollars > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;border-top:1px solid #334155;margin-top:6px;color:#94a3b8;"><span>Markup (${ai.profit_markup.markup_percent}%)</span><span>+ $${ai.profit_markup.markup_dollars.toFixed(2)}</span></div>` : ''}
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

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return phone.startsWith('+') ? phone : `+${digits}`
}

async function sendTwilioSms(to: string, body: string, accountSid: string, authToken: string, fromNumber: string): Promise<void> {
  const encoded = btoa(`${accountSid}:${authToken}`)
  const params = new URLSearchParams({ From: fromNumber, To: normalizePhone(to), Body: body })
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    },
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`SMS send failed: ${res.status} ${errText}`)
  }
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
// Send an estimate via SMS using Twilio.
// ──────────────────────────────────────────────────────────────────────────

interface SendEstimateSmsPayload {
  clerkToken: string;
  input: {
    to: string;
    fromName?: string;
    estimate: {
      customerName: string;
      jobTypeName: string;
      jobLocationZip?: string;
      total: number;
    };
  };
}

export const sendEstimateSms = onCall<SendEstimateSmsPayload>(
  {
    secrets: [CLERK_SECRET_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendEstimateSmsPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing phone number')
    if (!input?.estimate) throw new HttpsError('invalid-argument', 'Missing estimate data')
    if (!input.estimate.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input.estimate.jobTypeName) throw new HttpsError('invalid-argument', 'Missing jobTypeName')
    const phoneDigits = input.to.replace(/\D/g, '')
    if (phoneDigits.length < 10) throw new HttpsError('invalid-argument', 'Invalid phone number')

    const userId = await verifyClerk(clerkToken)
    console.log(`sendEstimateSms user=${userId} to=${input.to} job=${input.estimate.jobTypeName}`)

    const { customerName, jobTypeName, jobLocationZip, total } = input.estimate
    const fromName = input.fromName || 'Your Contractor'
    const zipPart = jobLocationZip ? ` at ZIP ${jobLocationZip}` : ''
    const body = `Hi ${customerName}! ${fromName} sent you an estimate for ${jobTypeName}${zipPart}.\n\nTotal: $${total.toFixed(2)}\n\nReply to this number to discuss. Thank you!`

    try {
      await sendTwilioSms(
        input.to,
        body,
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value(),
        TWILIO_FROM_NUMBER.value(),
      )
      return { ok: true }
    } catch (err) {
      console.error('sendEstimateSms error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `SMS send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Send an invoice via email using Resend.
// ──────────────────────────────────────────────────────────────────────────

interface SendInvoiceEmailPayload {
  clerkToken: string;
  input: {
    to: string;
    fromName?: string;
    replyTo?: string;
    invoice: {
      customerName: string;
      jobTypeName: string;
      invoiceType: 'deposit' | 'milestone' | 'final';
      amount: number;
      description: string;
      dueDate?: string;
      notes?: string;
    };
  };
}

function renderInvoiceEmailHtml(input: SendInvoiceEmailPayload['input']): string {
  const { invoice, fromName: rawFromName } = input
  const fromName = rawFromName || 'Your Contractor'
  const invoiceTypeLabel = invoice.invoiceType.charAt(0).toUpperCase() + invoice.invoiceType.slice(1)

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Invoice from ${escapeHtml(fromName)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2e;">
  <div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a1f2e;color:white;padding:24px;">
      <h1 style="margin:0 0 4px;color:#f97316;font-size:24px;">Invoice — ${escapeHtml(invoiceTypeLabel)}</h1>
      <p style="margin:0;color:#94a3b8;font-size:14px;">From ${escapeHtml(fromName)}</p>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(invoice.customerName)},</p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Please find your <strong>${escapeHtml(invoiceTypeLabel.toLowerCase())} invoice</strong> for <strong>${escapeHtml(invoice.jobTypeName)}</strong> below.</p>

      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Description</h3>
      <p style="font-size:14px;line-height:1.5;margin:0 0 20px;">${escapeHtml(invoice.description)}</p>

      <div style="background:#1a1f2e;color:white;padding:20px;border-radius:8px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:2px solid #f97316;">
          <span style="color:#fb923c;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Amount Due</span>
          <span style="color:#f97316;font-size:28px;font-weight:700;">$${invoice.amount.toFixed(2)}</span>
        </div>
        ${invoice.dueDate ? `<div style="padding-top:12px;font-size:14px;color:#94a3b8;">Due Date: <span style="color:white;font-weight:600;">${escapeHtml(invoice.dueDate)}</span></div>` : ''}
      </div>

      ${invoice.notes ? `
      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Notes</h3>
      <p style="font-size:14px;line-height:1.5;margin:0 0 20px;">${escapeHtml(invoice.notes)}</p>` : ''}

      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0 0 8px;">Reply to this email with any questions or to arrange payment.</p>
      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0;">Thank you,<br/><strong style="color:#1a1f2e;">${escapeHtml(fromName)}</strong></p>
    </div>
  </div>
</body></html>`
}

export const sendInvoiceEmail = onCall<SendInvoiceEmailPayload>(
  {
    secrets: [CLERK_SECRET_KEY, RESEND_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendInvoiceEmailPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing email address')
    if (!input?.invoice) throw new HttpsError('invalid-argument', 'Missing invoice data')
    if (!input.invoice.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input.invoice.jobTypeName) throw new HttpsError('invalid-argument', 'Missing jobTypeName')
    if (!input.invoice.description) throw new HttpsError('invalid-argument', 'Missing description')
    if (input.invoice.amount == null) throw new HttpsError('invalid-argument', 'Missing amount')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new HttpsError('invalid-argument', 'Invalid email address')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`sendInvoiceEmail user=${userId} to=${input.to} type=${input.invoice.invoiceType} job=${input.invoice.jobTypeName}`)

    const fromName = input.fromName || 'Contractors Office'
    const { invoiceType, jobTypeName } = input.invoice
    const subject = `Invoice from ${fromName} — ${invoiceType.charAt(0).toUpperCase() + invoiceType.slice(1)} for ${jobTypeName}`
    const html = renderInvoiceEmailHtml(input)

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <onboarding@resend.dev>`,
          to: [input.to],
          subject,
          html,
          reply_to: input.replyTo || undefined,
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
// Send an invoice via SMS using Twilio.
// ──────────────────────────────────────────────────────────────────────────

export const sendInvoiceSms = onCall<SendInvoiceEmailPayload>(
  {
    secrets: [CLERK_SECRET_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendInvoiceEmailPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing phone number')
    if (!input?.invoice) throw new HttpsError('invalid-argument', 'Missing invoice data')
    if (!input.invoice.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input.invoice.jobTypeName) throw new HttpsError('invalid-argument', 'Missing jobTypeName')
    if (!input.invoice.description) throw new HttpsError('invalid-argument', 'Missing description')
    if (input.invoice.amount == null) throw new HttpsError('invalid-argument', 'Missing amount')
    const phoneDigits = input.to.replace(/\D/g, '')
    if (phoneDigits.length < 10) throw new HttpsError('invalid-argument', 'Invalid phone number')

    const userId = await verifyClerk(clerkToken)
    console.log(`sendInvoiceSms user=${userId} to=${input.to} type=${input.invoice.invoiceType} job=${input.invoice.jobTypeName}`)

    const { customerName, jobTypeName, invoiceType, amount, description, dueDate } = input.invoice
    const fromName = input.fromName || 'Your Contractor'
    const invoiceTypeLabel = invoiceType.charAt(0).toUpperCase() + invoiceType.slice(1)
    const duePart = dueDate ? `Due: ${dueDate}\n` : ''
    const body = `Hi ${customerName}! ${fromName} sent you a ${invoiceTypeLabel.toLowerCase()} invoice for ${jobTypeName}.\n\nAmount Due: $${amount.toFixed(2)}\n${description}\n${duePart}\nThank you!`

    try {
      await sendTwilioSms(
        input.to,
        body,
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value(),
        TWILIO_FROM_NUMBER.value(),
      )
      return { ok: true }
    } catch (err) {
      console.error('sendInvoiceSms error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `SMS send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Send a change order via email using Resend.
// ──────────────────────────────────────────────────────────────────────────

interface SendChangeOrderEmailPayload {
  clerkToken: string;
  input: {
    to: string;
    fromName?: string;
    replyTo?: string;
    changeOrder: {
      customerName: string;
      jobTypeName: string;
      description: string;
      additionalAmount: number;
      newTotal: number;
    };
  };
}

function renderChangeOrderEmailHtml(input: SendChangeOrderEmailPayload['input']): string {
  const { changeOrder, fromName: rawFromName } = input
  const fromName = rawFromName || 'Your Contractor'

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Change Order — ${escapeHtml(changeOrder.jobTypeName)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2e;">
  <div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a1f2e;color:white;padding:24px;">
      <h1 style="margin:0 0 4px;color:#f97316;font-size:24px;">Change Order</h1>
      <p style="margin:0;color:#94a3b8;font-size:14px;">From ${escapeHtml(fromName)}</p>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(changeOrder.customerName)},</p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">There is a change order for your <strong>${escapeHtml(changeOrder.jobTypeName)}</strong> project that requires your review.</p>

      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;color:#64748b;letter-spacing:1px;">Change Description</h3>
      <p style="font-size:14px;line-height:1.5;margin:0 0 20px;">${escapeHtml(changeOrder.description)}</p>

      <div style="background:#1a1f2e;color:white;padding:20px;border-radius:8px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;">
          <span style="color:#cbd5e1;">Additional Amount</span>
          <span style="font-weight:600;">+$${changeOrder.additionalAmount.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;border-top:2px solid #f97316;margin-top:8px;">
          <span style="color:#fb923c;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">New Total</span>
          <span style="color:#f97316;font-size:28px;font-weight:700;">$${changeOrder.newTotal.toFixed(2)}</span>
        </div>
      </div>

      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0 0 8px;">Reply to this email to approve or discuss this change order.</p>
      <p style="font-size:14px;line-height:1.5;color:#64748b;margin:0;">Thank you,<br/><strong style="color:#1a1f2e;">${escapeHtml(fromName)}</strong></p>
    </div>
  </div>
</body></html>`
}

export const sendChangeOrderEmail = onCall<SendChangeOrderEmailPayload>(
  {
    secrets: [CLERK_SECRET_KEY, RESEND_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendChangeOrderEmailPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing email address')
    if (!input?.changeOrder) throw new HttpsError('invalid-argument', 'Missing changeOrder data')
    if (!input.changeOrder.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input.changeOrder.jobTypeName) throw new HttpsError('invalid-argument', 'Missing jobTypeName')
    if (!input.changeOrder.description) throw new HttpsError('invalid-argument', 'Missing description')
    if (input.changeOrder.additionalAmount == null) throw new HttpsError('invalid-argument', 'Missing additionalAmount')
    if (input.changeOrder.newTotal == null) throw new HttpsError('invalid-argument', 'Missing newTotal')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new HttpsError('invalid-argument', 'Invalid email address')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`sendChangeOrderEmail user=${userId} to=${input.to} job=${input.changeOrder.jobTypeName}`)

    const fromName = input.fromName || 'Contractors Office'
    const { jobTypeName, customerName } = input.changeOrder
    const subject = `Change Order — ${jobTypeName} for ${customerName}`
    const html = renderChangeOrderEmailHtml(input)

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <onboarding@resend.dev>`,
          to: [input.to],
          subject,
          html,
          reply_to: input.replyTo || undefined,
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('Resend change order send failed', res.status, errText)
        throw new HttpsError('internal', `Email send failed: ${res.status}`)
      }
      const data = await res.json() as { id?: string }
      return { ok: true, emailId: data.id }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('sendChangeOrderEmail error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `Email send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Send a change order via SMS using Twilio.
// ──────────────────────────────────────────────────────────────────────────

export const sendChangeOrderSms = onCall<SendChangeOrderEmailPayload>(
  {
    secrets: [CLERK_SECRET_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendChangeOrderEmailPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing phone number')
    if (!input?.changeOrder) throw new HttpsError('invalid-argument', 'Missing changeOrder data')
    if (!input.changeOrder.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input.changeOrder.jobTypeName) throw new HttpsError('invalid-argument', 'Missing jobTypeName')
    if (!input.changeOrder.description) throw new HttpsError('invalid-argument', 'Missing description')
    if (input.changeOrder.additionalAmount == null) throw new HttpsError('invalid-argument', 'Missing additionalAmount')
    if (input.changeOrder.newTotal == null) throw new HttpsError('invalid-argument', 'Missing newTotal')
    const phoneDigits = input.to.replace(/\D/g, '')
    if (phoneDigits.length < 10) throw new HttpsError('invalid-argument', 'Invalid phone number')

    const userId = await verifyClerk(clerkToken)
    console.log(`sendChangeOrderSms user=${userId} to=${input.to} job=${input.changeOrder.jobTypeName}`)

    const { customerName, jobTypeName, description, additionalAmount, newTotal } = input.changeOrder
    const fromName = input.fromName || 'Your Contractor'
    const body = `Hi ${customerName}! ${fromName} has a change order for your ${jobTypeName} project.\n\nChange: ${description}\nAdditional: +$${additionalAmount.toFixed(2)}\nNew Total: $${newTotal.toFixed(2)}\n\nReply to this number to approve or discuss.`

    try {
      await sendTwilioSms(
        input.to,
        body,
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value(),
        TWILIO_FROM_NUMBER.value(),
      )
      return { ok: true }
    } catch (err) {
      console.error('sendChangeOrderSms error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `SMS send failed: ${msg}`)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Send a general-purpose message to a customer via Resend.
// ──────────────────────────────────────────────────────────────────────────

interface SendCustomerEmailPayload {
  clerkToken: string;
  input: {
    to: string;
    fromName?: string;
    replyTo?: string;
    customerName: string;
    subject: string;
    body: string;
  };
}

export const sendCustomerEmail = onCall<SendCustomerEmailPayload>(
  {
    secrets: [CLERK_SECRET_KEY, RESEND_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  async (request) => {
    const { clerkToken, input } = request.data ?? ({} as SendCustomerEmailPayload)
    if (!clerkToken) throw new HttpsError('unauthenticated', 'Missing Clerk token')
    if (!input?.to) throw new HttpsError('invalid-argument', 'Missing email address')
    if (!input?.customerName) throw new HttpsError('invalid-argument', 'Missing customerName')
    if (!input?.subject) throw new HttpsError('invalid-argument', 'Missing subject')
    if (!input?.body) throw new HttpsError('invalid-argument', 'Missing body')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
      throw new HttpsError('invalid-argument', 'Invalid email address')
    }

    const userId = await verifyClerk(clerkToken)
    console.log(`sendCustomerEmail user=${userId} to=${input.to}`)

    const fromName = input.fromName || 'Your Contractor'
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2e;">
  <div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a1f2e;padding:24px;">
      <p style="margin:0;color:#f97316;font-size:18px;font-weight:700;">${escapeHtml(fromName)}</p>
    </div>
    <div style="padding:28px;">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(input.customerName)},</p>
      <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0 0 24px;">${escapeHtml(input.body)}</div>
      <p style="font-size:13px;color:#64748b;margin:0;">Reply to this email with any questions.<br/>Thank you,<br/><strong style="color:#1a1f2e;">${escapeHtml(fromName)}</strong></p>
    </div>
  </div>
</body></html>`

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <onboarding@resend.dev>`,
          to: [input.to],
          subject: input.subject,
          html,
          reply_to: input.replyTo || undefined,
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('sendCustomerEmail Resend error', res.status, errText)
        throw new HttpsError('internal', `Email send failed: ${res.status}`)
      }
      const data = await res.json() as { id?: string }
      return { ok: true, emailId: data.id }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('sendCustomerEmail error', err)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpsError('internal', `Email send failed: ${msg}`)
    }
  },
)
