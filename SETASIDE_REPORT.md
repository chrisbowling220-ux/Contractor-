# 1099 Set-Aside: Safe-to-Spend Calculator report

**Live:** https://builderspro.cc/safe-to-spend (shipped 2026-10-19)

## Status

| Done when… | Result |
|---|---|
| Page is live | ✅ `/safe-to-spend` and `/safe-to-spend/` return 200 on builderspro.cc |
| The math passes the tests | ✅ 29/29 engine tests. All of your expected numbers matched the official sources, so no test values changed |
| Signups save to Firestore | ✅ Rules deployed. The client writes exactly the shape the rules accept, and 12/12 emulator tests pass. Per your instruction, I did **not** submit a test signup to production |
| Nothing else broke | ✅ `/`, `/terms`, `/privacy`, `/q/…`, `/inv/…`, sitemap, robots: all 200. The homepage, /terms and the calculator load in headless Chrome with zero JS errors. The live homepage HTML is byte-identical to this build |
| assetlinks.json | ✅ 200, byte-identical before and after (sha256 `cbf950eb…8404`) |
| Report | ✅ This file |

**There is nothing left for you to run.**

## What I built

- **A public page at `/safe-to-spend`** with no sign-in.
  - Tabs: This Payment (the default) and Whole Year.
  - A collapsed "More options" section: filing status, state (NC / none / other %), and other income.
  - Live output with no submit button:
    - a huge "Yours to spend"
    - the set-aside with its %
    - an expandable breakdown, including a "cushion" line for the round-up
    - the next IRS due date
    - the tip line and the disclaimer
  - Materials money is shown as "covering your costs."
- **Email capture** goes to Firestore `setaside_waitlist`.
  - Honeypot field, a 3-second minimum before submit, and duplicate signups still show success.
- **Content:** "Common write-offs for the trades" and 5 FAQ items.
- **SEO:**
  - Title, description, canonical, Open Graph and Twitter tags.
  - WebApplication and FAQPage JSON-LD.
  - All of it is in the **served HTML**, not just added by JavaScript.
- **Links:** "Free Tools → Safe-to-Spend Calculator" in the signed-out landing footer and in the Terms/Privacy footer.
- **Accessibility:**
  - Every input has a label, and number fields use `inputMode="decimal"`.
  - Tabs are a real ARIA tablist with arrow, Home and End keys.
  - Orange focus rings.
  - AA contrast: buttons use a deeper orange `#c2410c`, because the brand `#f97316` on white is only 2.8:1.
  - 56px inputs and buttons.

### Files

**New**
- `src/SafeToSpend.tsx`: the page.
- `src/safeToSpendMain.tsx` and `safe-to-spend.html`: a standalone entry for the page.
- `src/lib/setaside/taxEngine.ts`: the pure engine.
- `src/lib/setaside/types.ts`
- `src/lib/setaside/taxYears/2026.ts`: every number, with its source URL.
- `src/lib/setaside/taxYears/index.ts`: the year registry.
- `src/lib/setaside/content.ts`: meta, FAQ and write-off copy. The page and the prerender both read it, so they stay in sync.
- `src/lib/setaside/waitlist.ts` and `firestoreWrite.ts`
- `src/lib/setaside/taxEngine.test.ts`
- `tests/waitlist.rules.test.ts`
- `vitest.config.ts` and `vitest.rules.config.ts`

**Changed**
- `src/App.tsx`: the `/safe-to-spend` route (`isSafeToSpendUrl`) and the footer link.
- `src/LegalPages.tsx`: the footer link only.
- `firestore.rules`: one new block (see the diff below).
- `firebase.json`: two rewrites so `/safe-to-spend` and `/safe-to-spend/` serve `/safe-to-spend.html`.
- `vite.config.ts`: a second build entry plus a `prerenderSafeToSpend` plugin.
- `public/sitemap.xml`: added `/safe-to-spend`.
- `package.json`: scripts `test` and `test:rules`; dev deps `vitest` and `@firebase/rules-unit-testing@5`.

**Git:** branch `feature/safe-to-spend` has 5 commits. It is merged `--no-ff` into `master` (merge commit 24c01ae) and pushed to origin.

## How the site deploys (for future reference)

- **Repo:** `~/buildpro-plus`, at github.com/chrisbowling220-ux/Contractor-
  - The default branch is **`master`**. There is no `main`, so I merged to `master`.
- **Hosting:** Firebase Hosting on the `contractors-office-96731` site. It serves `dist/` and rewrites every path to `/index.html`.
  - `builderspro.cc` has an A record to `199.36.158.100`, which is Firebase. I confirmed this with `dig` and `curl -sI`.
  - **A git push does not deploy.** You deploy by hand with:
    - `npm run build`
    - `firebase deploy --only hosting,firestore:rules --project contractors-office-96731`
- **Routing:** there is no router library. `App()` in `src/App.tsx` reads the URL path directly.
  - The calculator is also its own Vite entry (`safe-to-spend.html`), so it doesn't download Clerk or the signed-in app.
  - The `App.tsx` route is a fallback that renders the same component.
- **Deploy quirk this run:** the CLI exited 1 with "supplied version … is the current active version".
  - The rules **had** released, and the hosting version **had** gone live. The live homepage HTML matches `dist/` and the new bundles are served.
  - It looks like the CLI's release call was retried after the first call already succeeded.
  - I verified the live state rather than redeploying.

## Tax numbers used (all checked 2026-10-19)

| Item | Value | Source |
|---|---|---|
| Social Security wage base 2026 | $184,500 | https://www.ssa.gov/OACT/COLA/cbb.html |
| SE tax | 12.4% SS (to the wage base) + 2.9% Medicare, on 92.35% of net; none under $400 | https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes |
| Additional Medicare | 0.9% over $200k (single/HoH) / $250k (MFJ) | https://www.irs.gov/taxtopics/tc560 |
| Standard deduction | $16,100 single / $32,200 MFJ / $24,150 HoH | Rev. Proc. 2025-32 §.14, https://www.irs.gov/pub/irs-drop/rp-25-32.pdf |
| Single brackets | 10% ≤12,400; 12% ≤50,400; 22% ≤105,700; 24% ≤201,775; 32% ≤256,225; 35% ≤640,600; 37% above | Rev. Proc. 2025-32 Table 3 |
| MFJ brackets | 10% ≤24,800; 12% ≤100,800; 22% ≤211,400; 24% ≤403,550; 32% ≤512,450; 35% ≤768,700; 37% above | Rev. Proc. 2025-32 Table 1 |
| **HoH brackets** | 10% ≤17,700; 12% ≤67,450; 22% ≤105,700; 24% ≤201,750; 32% ≤256,200; 35% ≤640,600; 37% above | Rev. Proc. 2025-32 Table 2 |
| **QBI threshold 2026** | $201,750 single/HoH; $403,500 MFJ (20% rate) | Rev. Proc. 2025-32 §.26 |
| NC rate | 3.99% (tax years after 2025) | https://www.ncdor.gov/taxes-forms/tax-rate-schedules |
| NC standard deduction | $12,750 single / $25,500 MFJ / $19,125 HoH | https://www.ncdor.gov/taxes-forms/individual-income-tax/north-carolina-standard-deduction-or-north-carolina-itemized-deductions |
| Mileage | 72.5¢ (Jan 1–Jun 30), 76¢ (from Jul 1, 2026) | https://www.irs.gov/tax-professionals/standard-mileage-rates (IR-2025-128; IR-2026-29 / Announcement 2026-11, IRB 2026-29) |
| Estimated tax due dates | Apr 15, Jun 15, Sep 15 2026; Jan 15 2027 | https://www.irs.gov/faqs/estimated-tax/individuals/individuals-2 |
| FAQ: $1,000 rule and 90%/100%/110% safe harbor | (statutory) | IRS Pub. 505 / Form 1040-ES |

**Notes on the numbers**

- Every number you gave me matched the official source, so no tests changed.
- The NCDOR page lists $12,750 / $25,500 / $19,125 as the 2025 amounts. NC hasn't published a different 2026 amount, and Carolina Journal reports it unchanged for 2026, so I used those.
- **2027:** irs.gov had not published the 2027 inflation Rev. Proc. as of today. I shipped 2026 only.
  - The year registry (`taxYears/index.ts`) picks the config for today's calendar year, and falls back to the newest year it has.
  - The "next due date" falls back to the standard dates, moved off weekends, so it never goes blank after Jan 15, 2027.

**Main test case (single, NC, $50,000 net):**
- SE tax $7,064.78
- Federal income tax $2,667.29
- NC tax $1,345.33
- Total $11,077.40
- Rate 22.155%, rounded up to **23%**

**This Payment case ($2,000 payment, $500 materials, $50k year):** $345 set aside, $1,155 yours. I checked this in the engine and also by typing it into the real page in headless Chrome.

## firestore.rules diff

Only this block was added. It sits above the existing deny-all catch-all, and no existing rule changed.

- There's no `gcloud` on this box, so I couldn't pull the deployed ruleset through the Rules REST API.
- The repo file has been the deploy source for every earlier rules release, so I used it as the base.

```diff
diff --git a/firestore.rules b/firestore.rules
index 01687ed..712967a 100644
--- a/firestore.rules
+++ b/firestore.rules
@@ -215,6 +215,41 @@ service cloud.firestore {
       allow write: if false;
     }
 
+    // setaside_waitlist/{id}: 1099 Set-Aside early-access signups from the
+    // public /safe-to-spend page. Anyone may CREATE one well-formed signup;
+    // nobody can read, change or delete them from a client (view them in the
+    // Firebase console). The doc id is sha256(lowercased email), so a repeat
+    // signup hits an existing doc, counts as an update, and is denied.
+    function isSetasideSignup(id) {
+      let d = request.resource.data;
+      let trades = ['Handyman', 'General contractor', 'Carpenter', 'Electrician',
+                    'Plumber', 'HVAC', 'Painter', 'Roofer', 'Landscaping/lawn',
+                    'Flooring', 'Other'];
+      return d.keys().hasAll(['email', 'emailLower', 'trade', 'source', 'filingStatus',
+                              'state', 'annualNetBucket', 'createdAt'])
+        && d.keys().hasOnly(['email', 'emailLower', 'trade', 'firstName', 'source',
+                             'filingStatus', 'state', 'annualNetBucket', 'utm_source',
+                             'utm_medium', 'utm_campaign', 'createdAt'])
+        && d.email is string && d.email.size() < 254
+        && d.email.matches('^[^@\\s]+@[^@\\s]+[.][^@\\s]+$')
+        && d.emailLower == d.email.trim().lower()
+        && id == hashing.sha256(d.emailLower).toHexString().lower()
+        && d.trade in trades
+        && d.source == 'safe-to-spend-calculator'
+        && d.filingStatus in ['single', 'mfj', 'hoh']
+        && d.state in ['nc', 'none', 'other']
+        && d.annualNetBucket is string && d.annualNetBucket.size() <= 12
+        && (!('firstName' in d) || (d.firstName is string && d.firstName.size() <= 60))
+        && (!('utm_source' in d) || (d.utm_source is string && d.utm_source.size() <= 100))
+        && (!('utm_medium' in d) || (d.utm_medium is string && d.utm_medium.size() <= 100))
+        && (!('utm_campaign' in d) || (d.utm_campaign is string && d.utm_campaign.size() <= 100))
+        && d.createdAt == request.time;
+    }
+    match /setaside_waitlist/{id} {
+      allow create: if isSetasideSignup(id);
+      allow read, update, delete: if false;
+    }
+
     // Everything else: denied.
     match /{document=**} {
       allow read, write: if false;
```

## Where signups land

- **Firestore collection:** `setaside_waitlist` in project `contractors-office-96731`.
- **View them here:** https://console.firebase.google.com/project/contractors-office-96731/firestore/databases/-default-/data/~2Fsetaside_waitlist
  - Or go to Firebase console → Firestore Database → Data → `setaside_waitlist`.
- **Doc ID** is the SHA-256 hex of the lowercased, trimmed email.
- **Fields:**
  - `email`, `emailLower`, `trade`
  - `firstName` (optional)
  - `source` = `safe-to-spend-calculator`
  - `filingStatus`, `state` (`nc`/`none`/`other`)
  - `annualNetBucket`: one of `0`, `0-10k`, `10-25k`, `25-50k`, `50-75k`, `75-100k`, `100-150k`, `150-250k`, `250k+`
  - `utm_source`, `utm_medium`, `utm_campaign` (only when they're in the URL)
  - `createdAt`
- Clients can't read the list. Only the console or the Admin SDK can.

## Test and Lighthouse results

**Tests**
- `npm test`: 29/29 passed. Covers:
  - the main case
  - $0 and negative net
  - under $400
  - over the wage base (SS capped at $22,878, Additional Medicare, QBI skipped plus the note)
  - W-2 using up the wage base
  - MFJ and HoH
  - Other % and no-state
  - This Payment, and materials bigger than the payment
  - rate rounding, due dates, buckets
- `npm run test:rules` (Firestore emulator, Java 21): 12/12 passed.
  - Allowed: a valid create, and a create with the optional fields.
  - Rejected: extra field; bad email; 254+ character email; doc ID that isn't the email hash; client-set `createdAt`; unknown trade or source; duplicate create; read (signed in or not); list; update; delete.

**Build and lint**
- `npm run build` succeeds. The only warning is the >500 kB chunk warning that was already there on master before I started. Two new warnings showed up during the work, and I fixed both.
- `eslint .`: 25 problems, exactly the same as on master before I started. None are in new files.

**Lighthouse, mobile, live URL**

| Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|
| **99** | **100** | **100** | **100** |

FCP 1.4 s, LCP 1.4 s, TBT 130 ms, CLS 0.

## Decisions I made on my own

1. **`master` stood in for "main"**, because that's this repo's default branch.
2. **The page is its own Vite entry**, prerendered at build time.
   - Your brief allowed prerendering this one route.
   - Inside the normal SPA, the page would load the whole 1.2 MB app (Clerk, Firebase and every screen).
   - As its own page it loads about 70 kB gzipped, and Firestore only downloads when someone taps Get Early Access.
   - Side effect: Vite now splits the main app into three files (`main`, `src`, `firebase`) loaded in parallel through modulepreload. The app's code didn't change. I checked that the live homepage loads with no errors.
3. **No Firebase Analytics, GA or App Check is set up in this project.** So I logged no events and added no App Check, as you asked.
4. **Duplicate signups:**
   - The rules only allow creates, and a repeat email hits the same doc ID. That counts as an update, so it's denied.
   - The client already checks everything the rules check, so a `permission-denied` is treated as "already on the list" and shows success.
   - Trade-off: if the rules were ever removed, failed signups would also look successful.
5. **The rules check the doc ID server-side:** `id == hashing.sha256(emailLower).toHexString().lower()`, and `emailLower == email.trim().lower()`. This means nobody can plant docs under made-up IDs.
6. **Bots that fill the honeypot get a fake "success" and nothing is written.** If someone submits in under 3 seconds, they see "Hang on a second, then tap Get Early Access again."
7. **The breakdown adds up to the set-aside.**
   - It shows SE, federal and state tax scaled to this payment, plus a "Cushion (rate rounded up to Z%)" line.
   - The "SE tax" line includes the 0.9% Additional Medicare tax.
8. **Empty or negative profit shows $0 and no tip line.** When materials are bigger than the payment, nothing is set aside and the "yours" amount never goes negative.
9. **The QBI note reads "Above $201,750? Talk to a CPA about your QBI deduction."** It uses the threshold for the selected filing status. It shows only when taxable income before QBI is over that threshold.
10. **The FAQ's "about 23%" example** is the engine's own result for a single filer in NC clearing $50,000.
11. **I skipped the link in the signed-in nav.** That sidebar switches between typed in-app pages (`NAV_ITEMS`); an outside link would mean changing the nav logic, and it's already full. Signed-out visitors see the footer link on the landing page.
12. **The open-graph image is `/icon-512.png`**, because there's no social card image yet. A 1200×630 card would make link previews look better. That's a future nice-to-have.
13. **`@firebase/rules-unit-testing` is pinned to v5**, because v6 needs firebase 13 and this app is on firebase 12.
14. **The fallback due dates after Jan 15, 2027 only skip weekends, not holidays.**
    - Example: Jan 15, 2028 falls on a Saturday, so the fallback shows Monday Jan 17. That's MLK Day, so the IRS date will actually be Jan 18.
    - This only matters until a 2027 config is added.

## Follow-ups (optional, nothing blocking)

- **When the IRS publishes the 2027 Rev. Proc. (late Oct/Nov 2026):**
  - Copy `taxYears/2026.ts` to `2027.ts` and update the numbers.
  - Set NC to 3.49% if the revenue trigger is confirmed. The NCDOR page doesn't list a 2027 rate yet.
  - Register it in `taxYears/index.ts`, then build and deploy hosting.
- **Exporting the list:** the console view is enough for now. When you want to email the list, a small Admin-SDK script or a BigQuery export will pull it.
