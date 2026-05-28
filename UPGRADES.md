# BuildPro+ — Upgrade Notes & Pre-Launch Checklist

A running list maintained during development. Not user-facing. Update as things
get done or new ideas come up.

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
