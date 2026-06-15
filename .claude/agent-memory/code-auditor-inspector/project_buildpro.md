---
name: project-buildpro
description: BuildPro+ contractor app — architecture notes and recurring audit findings (updated 2026-06-04 deep audit)
metadata:
  type: project
---

React+Vite+TS SPA. Auth: Clerk → Firebase bridge via exchangeFirebaseToken (mints custom token, uid == Clerk userId). Firestore + Storage + Cloud Functions (Firebase Functions v2). Stripe: invoice one-time payments + Pro subscription ($19.99/mo) + quarterly ($49.99/3mo) + pay-as-you-go quote credits ($1 each). Stripe Connect for contractor payouts (Express accounts). Claude Sonnet 4.6 for quote/change-order/thank-you/invoice generation. Google Speech-to-Text for voice. Resend for email. LIVE on builderspro.cc as of 2026-06-01.

**Key architecture facts:**
- All Firestore collections keyed by `createdBy == userId`. Firestore rules enforce this for writes; public pages get `allow read: if true` on estimates, changeOrders, invoices, customers, customerPhotos, thankYouPackages, users.
- Stripe amounts are ALWAYS read server-side from Firestore (never trusted from client). Invoice checkout function reads `amountDue` from DB.
- Webhook signature verified with `constructEvent` before any trust.
- `consumeAiQuoteOrThrow` uses a Firestore transaction to atomically gate/increment AI usage.
- `PRO_PRICE_ID = 'price_1Tbj8IKz3SO2ZkDQQ4gjBq9j'` (monthly), `PRO_PRICE_ID_QUARTERLY = 'price_1TeC7OKz3SO2ZkDQy643dlQI'` (quarterly).
- `PUBLIC_HOST = 'https://builderspro.cc'` — live on custom domain.
- `EMAIL_DOMAIN_VERIFIED = true` → emails from alerts@builderspro.cc.
- `EMAIL_REPLY_TO_DEFAULT = 'chrisbowling220@gmail.com'` — owner's personal email hardcoded as fallback reply-to in sendEstimateEmail.

**FIXED FROM PRIOR AUDIT (2026-06-01):**
- Firestore tier-escalation vulnerability: `users/{userId}` write rule now has `isUserProfileKeys` allowlist blocking client writes to tier/stripe*/aiQuotesUsed/etc. CONFIRMED FIXED.

**ACTIVE FINDINGS (2026-06-04 audit):**

MEDIUM — Clerk test key in production:
- `.env.local` has `VITE_CLERK_PUBLISHABLE_KEY=pk_test_...` (test key) while `VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...` (live key). Clerk test-mode and live-mode Stripe running together. Likely won't cause data loss but is inconsistent — user accounts may exist in Clerk test environment, not production.

MEDIUM — checkout.session.completed subscription upgrade not idempotent:
- When mode=='subscription', the webhook writes tier='pro' without checking whether it already did so. Stripe may deliver this event twice (at-least-once). Safe in practice because writing tier='pro' twice is harmless, but the subscription events (customer.subscription.created/updated) ARE idempotent via applySubscriptionStatus. Not a real-money risk.

MEDIUM — account.updated webhook doesn't cross-validate Connect account ID:
- Handler at line 2222 uses `acct.metadata?.clerkUserId` to find the user and updates their `connectPayoutsEnabled`. Does NOT verify that `acct.id == user.stripeConnectId`. A Stripe platform-level attack could theoretically update the wrong user's flag. Extremely low risk in practice (webhook is signature-verified), but worth a cross-check.

MEDIUM — grantOwnerPro function still deployed (temp function not removed):
- `grantOwnerPro` and OWNER_USER_ID are still live in the deployed functions. Auth-locked to the owner's Clerk UID and confirmed safe, but should be deleted now that it's been used.
- Same button still in Settings.tsx line 379. Should both be removed post-setup.

LOW — sendEstimateEmail has owner's personal email as hardcoded default reply-to:
- `EMAIL_REPLY_TO_DEFAULT = 'chrisbowling220@gmail.com'` at line 69 is the fallback reply-to for ALL outgoing estimate emails when the contractor hasn't set a replyTo. When multi-tenant, every contractor's estimate email defaults to the owner's inbox. Should default to no reply-to or the 'from' address instead.

LOW — No input size validation on transcribeAudio audio payload:
- `transcribeAudio` accepts `audioBase64` string with no length check. A client could send an arbitrarily large base64 string, burning memory and hitting the 512MiB function memory limit. Should add a max size check (e.g. reject if length > ~4MB base64 ≈ 3MB audio).

LOW — emailContractor injects unescaped Firestore data into HTML:
- The `bodyHtml` argument passed to `emailContractor` contains unescaped `customerName`, `jobTypeName`, `reason` from Firestore docs. If an adversarial customer sets their name to contain HTML like `<script>`, it could be rendered in the contractor's email client. Emails go only to the contractor (not an attacker), so the risk is low, but escaping is recommended.

LOW — processedCreditSessions collection has no Firestore rules:
- This collection is written only by the webhook (Admin SDK) so it bypasses rules. No client can write to it. But the catch-all `/{document=**} allow read,write: if false` covers the gap correctly. Verified safe.

LOW — morningAgendaAlert iterates ALL users' calendar events and projects:
- No pagination. With many users this could hit Firestore limits or memory limits. Not a current concern for a small app, but worth noting for scale.

**VERIFIED CLEAN (2026-06-04):**
- No eval/exec/dynamic require in any source file.
- No hardcoded Stripe secret keys, Anthropic keys, Clerk secret keys, or webhook secrets committed to source.
- Only publishable keys are in .env.local; .env.local is in .gitignore via *.local pattern.
- Stripe webhook uses constructEvent with raw body for proper signature verification. CORS=false on stripeWebhook.
- Stripe checkout amounts read from Firestore server-side.
- AI quota gate uses Firestore transactions.
- All Cloud Functions requiring auth call verifyClerk before any data operation.
- debugForceFail is guarded to DEV=true only (stripped in production builds).
- createInvoiceCheckout reads amountDue from Firestore, not client body.
- createDepositInvoiceForApproval reads depositAmount from Firestore estimate doc.
- Idempotency: invoice payment check (status=='paid' guard), credit purchase (processedCreditSessions), invoice checkout (idempotencyKey on Stripe session).
- 2-year retention lock: withinRetention() math is correct (63,072,000,000ms = 730 days). signedDocLocked/paidInvoiceLocked logic verified.
- Public estimate sign-off rules: onlyChanges(['customerResponse','status','signedAtMs']) + status in ['approved','declined'] — correct. Can't forge amounts, totals, or other status values.
- grantOwnerPro is locked to a single hardcoded userId and verifies via Clerk token.
- Storage rules: all paths owner-only. Public pages use signed download URLs.
- autoConvertEstimates has race guard (checks for existing project by sourceEstimateId).
- No XSS via dangerouslySetInnerHTML anywhere in React.
- escapeHtml used in sendEstimateEmail renderEstimateEmailHtml.
- Tier/stripe* fields protected from client writes by Firestore isUserProfileKeys allowlist.
