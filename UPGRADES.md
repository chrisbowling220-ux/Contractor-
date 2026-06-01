# BuildPro+ — Upgrade Notes & Pre-Launch Checklist

A running list maintained during development. Not user-facing. Update as things
get done or new ideas come up.

> ⚠️ STACK NOTE: This app is **React + Firebase (Firestore + Cloud Functions)**.
> It is NOT Supabase/Postgres. Any SQL schema ideas must be translated to
> Firestore collections — do not bolt on a second backend.

## 🔖 CURRENT STATE — pick up here next session

**App is LIVE & launch-ready** at https://contractors-office-96731.web.app
Stripe is fully LIVE (real payments work, $1 test passed). Security audited clean.

**IN PROGRESS — Custom domain `builderspro.cc` (bought at Cloudflare):**
- DNS records ADDED in Cloudflare + confirmed propagating:
  - A record: `builderspro.cc` → `199.36.158.100` (DNS only / gray cloud)
  - TXT record: `builderspro.cc` → `hosting-site=contractors-office-96731`
- Firebase is provisioning SSL (auto, takes mins–hours). NOT live yet.
- All app share-links centralized into `src/lib/config.ts` — to switch the whole
  app to the new domain, change the ONE `PUBLIC_HOST` line there to
  `https://builderspro.cc` and deploy hosting. (Currently still .web.app so
  nothing breaks while SSL provisions.)
- NEXT once Firebase shows builderspro.cc "Connected" with SSL:
  1. Flip config.ts PUBLIC_HOST → builderspro.cc, `firebase deploy --only hosting`
  2. Verify `builderspro.cc` in Resend (resend.com) + add the DNS records it gives
     (SPF/DKIM TXT records) in Cloudflare — same copy-paste flow as Firebase DNS.
  3. Build the EMAIL FEATURES (all were waiting on the domain + Resend):
     - Customer invoice emails (currently sendEstimateEmail only reaches the
       account owner via Resend sandbox — domain unlocks sending to anyone)
     - "Customer signed" instant alert → email the contractor on approve/decline
     - Day-before job reminders → daily scheduled Cloud Function checks projects
       with startDate == tomorrow, emails contractor + customer. (Calendar/
       scheduling UI already built: Schedule page + startDate picker.)
- Branding note: domain is "builderspro" (plural) + .cc, app is "BuildPro+".
  Consider aligning branding or keeping both. Not blocking.

**Built this session (all deployed unless noted):** deposit system (toggle in
Quick Quote, pay deposit/full/cash in the estimate after approval, auto deposit
invoice via createDepositInvoiceForApproval fn), My Prices (app learns saved
material-price edits → userMaterialPrices/{uid}, fed to generator), multi-trade
knowledge (electrical/plumbing/HVAC/ground-up) + code-awareness (defers to local
AHJ), tighter material quantities (no over-counting), Schedule/calendar, business
stats + needs-attention dashboard, search, duplicate estimate, log-off in Settings.

**Still TODO after domain+email:** final 6-step human click-through test; Batch
items now folded into email features above. Stripe Connect 3% fee (documented
below) is the only big deferred build.

Docs in repo: PRESENTATION.md (full pitch), LAUNCH_KIT.md (marketing/posts/flyer).

## BIG FEATURE: Real per-ZIP material pricing (catalog + regional factors)

**Why:** The AI currently *estimates* regional prices from its training (good,
free, but not live). Contractors want accuracy to their actual local store.

**Legal reality (decided):** We do NOT scrape Lowes.com / HomeDepot.com — it
violates their ToS, gets IP-banned, and re-publishing their prices commercially
adds liability. There is no public Lowe's price API. So pricing data comes from:
(a) a catalog we maintain, (b) regional adjustment factors, (c) the contractor's
own saved prices, and/or (d) a licensed construction-cost data provider later.

**The design (Firestore translation of the proposed SQL schema):**

- `materials/{id}` (the product catalog — already partly exists in
  src/data/materials.ts): `{ sku, name, category, unit, basePrice, updatedAt }`
- `regionalPricing/{zipPrefix}`: `{ zipPrefix:"900", regionName:"Southern California",
  priceFactor:1.30, laborFactor:1.45 }` — first 3 ZIP digits → region + multiplier.
- `regionalPriceOverrides/{id}`: `{ materialId, zipPrefix, overridePrice }` —
  exact price for a specific item in a specific region when the factor isn't
  precise enough (high-value items).
- `userMaterialPrices/{userId}/{materialId}`: per-contractor real prices from
  THEIR store. Beats the regional estimate for that user. Most accurate + legal.
- Quotes already snapshot line items + prices at quote time (we store the full
  estimate doc), so no separate quotes table needed — Firestore `estimates`
  already does this.

**Flow:** user enters ZIP → look up `regionalPricing` by first 3 digits → get
region + factor. For each material the AI lists: price =
  userMaterialPrices override ?? regionalPriceOverride ?? (basePrice × factor).
The AI keeps doing what it's great at (deciding WHAT materials + quantities);
the catalog handles WHAT IT COSTS. Best of both.

**Admin (for Chris, platform owner):** a CSV import screen → bulk upsert into
`materials` (sku,name,category,unit,basePrice) and `regionalPricing`
(zipPrefix,regionName,priceFactor,laborFactor). Lets prices be refreshed from
any legitimate source (store visits, a price-data subscription).

**Effort:** multi-session build. Worth it once there are paying users and time
to maintain the price data (stale data is worse than a good estimate). Until
then, the improved AI regional estimates (deployed) are the pricing engine.

**Paid data option (when funded):** license RSMeans-style construction cost
data, or a compliant retail-price API (SerpApi / BlueCart / Bright Data — they
scrape on their own infra and sell results; still ToS-gray but shifts the risk
off us). Per-call cost; revisit when subscription revenue covers it.

## Before going live to the public

- [ ] **Flip Stripe to live mode** (do together, deliberately):
  - Create the $19.99/mo Pro product in Stripe LIVE mode → get the live `price_...`
  - Swap `PRO_PRICE_ID` in `functions/src/index.ts`
  - `firebase functions:secrets:set STRIPE_SECRET_KEY` → paste `sk_live_...`
  - Swap `VITE_STRIPE_PUBLISHABLE_KEY` in `.env.local` → `pk_live_...`
  - Add a LIVE webhook destination (same URL, events: `checkout.session.completed`,
    `customer.subscription.created/updated/deleted`) → set `STRIPE_WEBHOOK_SECRET`
  - Activate the Stripe Customer Portal in LIVE mode
  - Redeploy
- [ ] **Test the full payment flow in test mode first** (card `4242 4242 4242 4242`):
  invoice pay → marked paid → project auto-closes; Pro upgrade → tier flips; portal opens.
- [ ] **Buy a real domain** (recommended `usebuildpro.com`). Unlocks: Resend email to
  any recipient (currently sandbox-only), permanent Safe Browsing fix, clean share links.
  Point DNS at Firebase Hosting; verify domain in Resend.
- [ ] Confirm **Firebase Authentication** is enabled (custom-token sign-in) and the
  Cloud Functions service account has **Service Account Token Creator** (for the
  Clerk→Firebase bridge). Both done as of last check.

## Known limitations (acceptable for launch, revisit later)

- **Pricing is calibrated to North Carolina.** AI prompts use NC baseline pricing and
  scale by ZIP. Works elsewhere but is most accurate in NC. Future: per-region baselines.
- **Manual estimate** stores line items in `scopeOfWork` text + `materials[]`, but the
  EstimatePreview structured material editor only edits AI-quote materials. Manual
  estimates display/print/share correctly; they just aren't re-editable row-by-row in
  the preview. Future: synthesize an aiQuote-shaped object from manual input.
- **Security rules are open for `customerPhotos` reads** (public photo-log share page).
  Intended (it's a share link), same model as estimates/invoices.
- **Single-function deploys time out** (`Cannot determine backend specification`). Use
  `firebase deploy --only functions` (all at once) — that reliably succeeds.

## BIG FEATURE: Contractor payment accounts + 3% platform fee (Stripe Connect)

Goal (Chris's spec): A contractor can OPT IN (in Settings) to accept invoice
payments through the app. When they do, their customer pays the invoice by card
(customer picks the method), the money goes to the CONTRACTOR's own connected
account, and **3% of the payment is routed to Chris's platform Stripe account**
automatically. Chris's account stays private. No card/bank data is ever stored
in the app — it lives only in Stripe.

### Why this needs Stripe Connect (not the current setup)
Today invoice payments use a single Checkout Session that pays one account.
To split a fee to a platform account, each contractor must have their OWN
connected Stripe account, and we charge with an `application_fee_amount`.
This makes BuildPro+ a payment facilitator/marketplace.

### Architecture to build (when ready, do deliberately, test mode first)
1. **Connect account type**: use Stripe Connect **Express** (or the modern
   Accounts v2 with controller properties). Express gives Stripe-hosted
   onboarding + a Stripe-hosted dashboard for the contractor to manage their
   bank info — so banking data NEVER touches our app (satisfies the "hidden,
   Stripe-only, security-checked" requirement).
2. **Settings → "Accept payments" opt-in**: a button that calls a new
   `createConnectOnboardingLink` function → `stripe.accountLinks.create` →
   redirect the contractor to Stripe's onboarding (identity + bank). Store only
   the resulting `stripeConnectAccountId` on users/{id} (NOT bank details).
3. **Account status**: webhook `account.updated` → store `chargesEnabled`,
   `payoutsEnabled` booleans so we know if they're ready to accept.
4. **Invoice payment with fee**: change `createInvoiceCheckout` so that IF the
   contractor has a connected account, the Checkout Session uses
   `payment_intent_data.application_fee_amount = round(amountDue * 0.03 * 100)`
   and `transfer_data.destination = <contractor connect account>`. Customer
   pays → 97% to contractor, 3% to platform, automatically.
5. **Manage banking**: a "Manage payout account" button → `stripe.accountLinks`
   or Express dashboard login link. Re-auth via Clerk before revealing the link.
6. **Compliance**: platform ToS acceptance, Connect onboarding handles KYC.
   Chris's platform account id stays only in server-side secrets/config — never
   shipped to the client.

### Already done (the non-Connect parts of the spec)
- Approved estimate → auto to Projects (in_progress). ✓
- Stays until user taps "Mark Job Complete" → completed. ✓
- Completed → AI-generated, editable, branded final invoice (logo + profile). ✓
- Customer pays by card, picks method (dynamic payment methods). ✓
- Card data never stored — Stripe Checkout is hosted; app/db never see it. ✓

## Future upgrade ideas (nice-to-have)

- Re-editable manual estimates (see above).
- Per-region pricing baselines beyond NC.
- Customer-facing payment receipt email after Stripe payment.
- Dashboard: show overdue invoices count / a "needs attention" surface.
- Bundle size is ~870KB — consider code-splitting (lazy-load public pages) if load
  time becomes an issue.

## Recently fixed (this audit pass)

- Duplicate-project race (sweep vs inline create) → dedup by `sourceEstimateId`.
- Contract Total counted unapproved change orders → now approved-only.
- Gated all 4 AI features to the free tier + refund-on-failure so a failed
  generation doesn't cost a free credit.
- Manual estimate builder + invoice default-copy fallback (works when free tier used up).
- Re-open / edit / resend existing invoices from the project view.
- Live Settings tier/usage + live invoices list (no reload needed).
- Removed dead code (aiQuote.ts, rentals.ts, room templates, NC store list).
- Removed "AI" from all user-facing text; fixed a prompt that could leak "Chris Bowling".
