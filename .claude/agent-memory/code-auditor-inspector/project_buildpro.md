---
name: project-buildpro
description: BuildPro+ contractor app — architecture notes and audit findings from 2026-05-30 full security/correctness audit
metadata:
  type: project
---

React+Vite+TS SPA. Auth: Clerk → Firebase bridge via exchangeFirebaseToken (mints custom token, uid == Clerk userId). Firestore + Storage + Cloud Functions (Firebase Functions v2). Stripe: invoice one-time payments + Pro subscription ($19.99/mo).

**Key architecture facts:**
- All Firestore collections keyed by `createdBy == userId`. Firestore rules enforce this for writes; public pages get `allow read: if true` on estimates, changeOrders, invoices, customers, customerPhotos, thankYouPackages, users.
- Stripe amounts are ALWAYS read server-side from Firestore (never trusted from client). Invoice checkout function reads `amountDue` from DB.
- Webhook signature verified with `constructEvent` before any trust.
- `consumeAiQuoteOrThrow` uses a Firestore transaction to atomically gate/increment AI usage.
- `PRO_PRICE_ID = 'price_1TbzCzKz3SO2ZkDQ5M3ZYbyr'` — TEST-MODE price, needs swap before go-live.
- `PUBLIC_HOST` is duplicated in ~8 frontend files + functions/src/index.ts — all use the same value but no shared constant.
- `debugForceFail` param in `generateAIQuote`/`analyzeScan` is accessible via URL `?debugForceFail=overloaded` in ScanRoom.tsx — debug feature exposed in production build.

**Firestore rule issues found:**
- Estimate/ChangeOrder public update allows `status` field to be set to ANY string value (not just 'approved'/'declined'). Malicious user could set status='pending' on someone else's estimate to reset it.
- The `onlyChanges(['customerResponse','status'])` means anonymous write permission — no authentication required to flip status on ANY estimate/CO in the database. This is intentional by design (public sign-off) but the lack of value validation on `status` is a gap.

**Webhook idempotency gap:**
- `checkout.session.completed` handler does NOT check if invoice is already paid before overwriting. Stripe can send duplicate webhook events. Second delivery would overwrite `paidAt` with a new timestamp.

**Project-estimate matching weakness:**
- `aggregateForProject` in Projects.tsx matches estimates by `customerName + jobTypeName` (not by `projectId`). If two projects share same customer + job type, estimates bleed across projects. The correct field `sourceEstimateId`/`projectId` on the estimate is available but not used here.

**sessionStorage stale data on user switch:**
- Keys `bp_co_notified_{userId}` and `bp_inv_notified_{userId}` are user-scoped (safe).
- Key `bp_open_thanks_for_project` is NOT user-scoped. If user A switches to user B in same browser tab, user B could auto-open user A's project.

**Personal info in AI prompts:**
- NC_PRICING_GUIDANCE and SHED_KNOWLEDGE reference "Roxboro / Durham area" and "Person County" — region-specific flavor text baked into system prompts, shown to Claude but not customers.
- Settings placeholder "e.g. Bowling Construction LLC" — innocuous placeholder text.

**Stripe Connect fee:** Not built at all — no half-built code found.
**PRO_PRICE_ID:** Test-mode, explicitly noted with "swap to live price_... here when going live."
