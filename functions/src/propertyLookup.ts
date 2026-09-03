// The address lookup's prompts and output schema, kept out of index.ts so the
// two-pass flow can be run and eyeballed on real addresses without deploying.
// The handler itself stays in index.ts with the rest of the callables.

export const PROPERTY_LOOKUP_PROMPT = `You are looking up ONE specific property for a real estate agent or a buyer who is standing outside it right now, phone in hand. They want to know what this house is, what it's going for, and what they should know before they walk in — the things they'd otherwise get by opening the MLS, calling the listing agent, or pulling county records themselves.

Search for this address, then write up what you found as notes. Prose is fine; this is working material, not the finished answer.

WHAT TO GO AFTER, in this order:

1. IS IT ON THE MARKET RIGHT NOW, and for how much. Active, pending, contingent, recently sold, or off market entirely. If it's listed: the asking price, how long it's been listed, and any price cuts.
2. THE PHYSICAL FACTS: beds, baths, heated square feet, lot size, year built, property type, stories, garage/parking.
3. THE MONEY: last sale price and date, county tax assessed value, annual property taxes, HOA dues.
4. WHAT THE LISTING SAYS — the remarks, what's been updated, what they're bragging about, what they're carefully not mentioning.
5. COMPS: recent nearby sales of similar houses, with price, size and sale date.
6. THE LOCAL MARKET: median price and direction, typical days on market, whether it favors buyers or sellers right now.
7. ANYTHING A BUYER WOULD WANT FLAGGED: age of roof/HVAC/panel/plumbing if stated, foundation and crawlspace type, septic vs sewer, well vs city water, flood zone, permits, known issues, school assignment.

WHERE TO LOOK: the big listing portals, but do not stop there when they're thin — county tax assessor and GIS parcel records, the register of deeds, local brokerage sites, and recent local market reports are often more complete and more reliable than a scraped listing snippet.

HARD RULES — this is someone's money:

- NEVER invent a number. If you could not confirm something, write "not confirmed" and move on. A blank is useful; a plausible fabrication is worse than useless.
- Write the FULL URL of every page you used, inline, next to what you took from it. A later step reads only these notes, so a source without its link arrives unverifiable.
- Every number gets a source and a date. "Zillow, listed at $312,000, page dated this week." An unsourced number does not go in the notes.
- Keep ASKING PRICE, ESTIMATED VALUE, and LAST SOLD PRICE strictly apart, and label which is which every time. Confusing those three is the single most damaging mistake you can make here.
- If more than one property matches the address, say so and describe each rather than picking one.
- If the address doesn't resolve to a real property at all, say that plainly and stop. Do not substitute a nearby or similar address.
- If the listing sites are blocked or empty, say what you couldn't reach, then get what you can from public records. Partial and honest beats complete and invented.`

export const PROPERTY_EXTRACT_PROMPT = `Turn the research notes into the structured record. You are transcribing, not researching and not improving.

- A field the notes did not confirm is null. Never fill a gap from what's typical for houses like this — that is exactly the fabrication the notes were careful to avoid.
- Keep asking price, estimated value and last sold price in their own fields. Do not move a number between them because one is empty.
- List everything the notes confirmed that has no field of its own — roof age, septic, flood zone, schools, parking, permits — in extraFacts, one fact per entry.
- unconfirmed is for what an agent or buyer would expect to see and the notes could not establish. That list is a feature: it tells them what still needs a phone call.
- found is false only if the address never resolved to a real property.
- summary is two to four plain sentences: what this place is, what it's going for, and the one thing worth knowing. Write it the way you'd say it to someone standing on the sidewalk.`

// Every object needs additionalProperties:false and every property listed in
// required — structured outputs are strict, so "optional" is expressed as an
// explicit null, not an absent key.
//
// The API caps a schema at 16 union-typed (nullable) parameters, nested ones
// included, so nullability is spent only where a blank and a zero mean
// different things: the numbers. Text fields use an empty string for "not
// confirmed", and comps and sources carry pre-formatted display text instead of
// four nullable columns each — nothing does math on them.
function nullable(type: 'number' | 'integer', description: string) {
  return { anyOf: [{ type }, { type: 'null' }], description }
}

export const PROPERTY_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'found', 'confidence', 'normalizedAddress', 'status', 'statusNote',
    'listPrice', 'priceHistoryNote', 'estimatedValue', 'estimateSource',
    'lastSoldPrice', 'lastSoldDate', 'beds', 'baths', 'sqft', 'lotSizeAcres',
    'yearBuilt', 'propertyType', 'daysOnMarket', 'hoaMonthly', 'annualTaxes',
    'taxAssessedValue', 'parcelId', 'extraFacts', 'highlights', 'watchOuts',
    'comps', 'marketNote', 'unconfirmed', 'sources', 'summary',
  ],
  properties: {
    found: { type: 'boolean', description: 'False only if the address never resolved to a real property.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = a listing or county record for this exact address; medium = partial or indirect; low = little confirmed.' },
    normalizedAddress: { type: 'string', description: 'The full address as the records write it. Empty string if not confirmed.' },
    status: { type: 'string', enum: ['for_sale', 'pending', 'contingent', 'sold', 'off_market', 'for_rent', 'unknown'], description: 'Market status right now.' },
    statusNote: { type: 'string', description: 'One line on the status — when it listed, when it sold, when it went pending. Empty string if unknown.' },
    listPrice: nullable('number', 'Current ASKING price in dollars. Null if it is not currently listed.'),
    priceHistoryNote: { type: 'string', description: 'Price cuts, relistings, prior failed listings. Empty string if none found.' },
    estimatedValue: nullable('number', 'A published automated value estimate. Never the asking price.'),
    estimateSource: { type: 'string', description: 'Who published that estimate. Empty string if there is none.' },
    lastSoldPrice: nullable('number', 'What it last actually sold for.'),
    lastSoldDate: { type: 'string', description: 'When it last sold — YYYY-MM-DD or YYYY-MM. Empty string if unknown.' },
    beds: nullable('number', 'Bedrooms.'),
    baths: nullable('number', 'Bathrooms, half baths as .5.'),
    sqft: nullable('integer', 'Heated square feet.'),
    lotSizeAcres: nullable('number', 'Lot size in acres.'),
    yearBuilt: nullable('integer', 'Year built.'),
    propertyType: { type: 'string', description: 'Single family, townhouse, duplex, land, and so on. Empty string if unknown.' },
    daysOnMarket: nullable('integer', 'Days on market.'),
    hoaMonthly: nullable('number', 'HOA dues per month.'),
    annualTaxes: nullable('number', 'Annual property tax bill.'),
    taxAssessedValue: nullable('number', 'County assessed value.'),
    parcelId: { type: 'string', description: 'Parcel or PIN number from the assessor. Empty string if unknown.' },
    extraFacts: {
      type: 'array',
      description: 'Everything else confirmed that has no field of its own: roof, HVAC, panel, plumbing, foundation, septic or sewer, well or city water, flood zone, schools, garage, permits, subdivision.',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'value'],
        properties: { label: { type: 'string' }, value: { type: 'string' } },
      },
    },
    highlights: { type: 'array', description: 'What is genuinely good about it, per the sources.', items: { type: 'string' } },
    watchOuts: { type: 'array', description: 'What a buyer should look at hard — age, condition, anything the listing dances around.', items: { type: 'string' } },
    comps: {
      type: 'array',
      description: 'Recent nearby sales of similar properties.',
      items: {
        type: 'object', additionalProperties: false, required: ['address', 'detail'],
        properties: {
          address: { type: 'string', description: 'Street address of the comp.' },
          detail: { type: 'string', description: 'Price, size, sale date and how it compares, as one readable line: "$312,000 · 1,480 sq ft · sold Aug 2025 · smaller lot, no garage".' },
        },
      },
    },
    marketNote: { type: 'string', description: 'Local market conditions — direction, days on market, buyers or sellers. Empty string if not established.' },
    unconfirmed: { type: 'array', description: 'What could not be established and still needs a phone call.', items: { type: 'string' } },
    sources: {
      type: 'array',
      description: 'Where this came from.',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'url', 'asOf'],
        properties: {
          label: { type: 'string', description: 'Site or record, e.g. "Guilford County tax assessor".' },
          url: { type: 'string', description: 'Link, or empty string if there is none.' },
          asOf: { type: 'string', description: 'How current the page was, or empty string.' },
        },
      },
    },
    summary: { type: 'string', description: 'Two to four plain sentences, said the way you would say it to someone standing on the sidewalk.' },
  },
} as const

export interface PropertyComp { address: string; detail: string }
export interface PropertyFact { label: string; value: string }
export interface PropertySource { label: string; url: string; asOf: string }

export interface PropertyRecord {
  found: boolean
  confidence: 'high' | 'medium' | 'low'
  normalizedAddress: string
  status: 'for_sale' | 'pending' | 'contingent' | 'sold' | 'off_market' | 'for_rent' | 'unknown'
  statusNote: string
  listPrice: number | null
  priceHistoryNote: string
  estimatedValue: number | null
  estimateSource: string
  lastSoldPrice: number | null
  lastSoldDate: string
  beds: number | null
  baths: number | null
  sqft: number | null
  lotSizeAcres: number | null
  yearBuilt: number | null
  propertyType: string
  daysOnMarket: number | null
  hoaMonthly: number | null
  annualTaxes: number | null
  taxAssessedValue: number | null
  parcelId: string
  extraFacts: PropertyFact[]
  highlights: string[]
  watchOuts: string[]
  comps: PropertyComp[]
  marketNote: string
  unconfirmed: string[]
  sources: PropertySource[]
  summary: string
  lookedUpAt?: string
}
