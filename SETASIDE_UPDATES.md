# Safe-to-Spend tax-number updates

A dated log of the scheduled tax-number checks for the Safe-to-Spend
calculator (`src/lib/setaside/taxYears/`).

---

## 2026-10-19 — DRY RUN — No changes

**Checked** official sources only (irs.gov, ssa.gov, ncdor.gov) against every
value in `src/lib/setaside/taxYears/2026.ts`, and looked for a publishable 2027
tax year.

### Can a 2027 file be created? No.
A 2027 file needs *every* number, and the IRS numbers it depends on are not
published yet:

- **IRS annual inflation-adjustment Revenue Procedure for tax year 2027** — not
  yet published on irs.gov (it normally lands in late October). Without it the
  2027 income-tax brackets, standard deduction, and §199A QBI threshold do not
  exist on an official page. Two scoped searches of irs.gov returned only the
  2026 figures (Rev. Proc. 2025-32) and unrelated 2027-indexed items (HSA
  limits, estate/gift exclusion, information-return thresholds).
- **2027 standard mileage rate** — not published. The IRS standard-mileage page
  (https://www.irs.gov/tax-professionals/standard-mileage-rates) still lists
  only 2026: 72.5¢ (Jan 1–Jun 30) and 76¢ (Jul 1–Dec 31).

One 2027 number *is* official — the SSA contribution and benefit base of
**$192,300** for 2027 (ssa.gov cbb.html / 2027 COLA fact sheet) — but a single
confirmed figure is not enough to stand up a complete, correct year. Per the job
rules (stop if any number can't be confirmed on an official page), no 2027 file
was created.

### Did any existing 2026 number change? No.
Spot-confirmed the values the calculator uses are still current:

- SS wage base 2026 = $184,500 (ssa.gov — described as the prior-year base in
  the 2027 announcement). Unchanged.
- Standard mileage 2026 = 72.5¢ / 76¢ with the Jul 1 step-up
  (irs.gov standard-mileage-rates). Unchanged.
- Standard deduction 2026 = $16,100 / $32,200 / $24,150 (Rev. Proc. 2025-32).
  Unchanged.
- Income-tax brackets 2026 (Rev. Proc. 2025-32). Unchanged.
- NC flat rate 3.99% and NC standard deduction $12,750 / $25,500 / $19,125
  (ncdor.gov). Unchanged — no mid-year change.
- Estimated-tax due dates for 2026. Unchanged.

### Tests / build
- `npm test` — **29/29 passed**.
- `npm run build` — **succeeded** (production build, Vite).

### Deploy
No. DRY_RUN=1 and nothing changed. No commit, no push, no deploy.

### Blocked / notes
- Direct fetches of ssa.gov pages (cbb.html, 2027 fact sheet) returned HTTP 403
  (Akamai edge block) via both WebFetch and curl. The 2027 wage base figure
  above came from ssa.gov content surfaced through web search, not from a
  direct page load. This did not affect the outcome, since no number was
  written to any file this run.

---

## 2026-10-19 — Real run — No changes

**Checked** official sources only (irs.gov, ncdor.gov; ssa.gov via search only —
see notes) against every value in `src/lib/setaside/taxYears/2026.ts`, and
looked again for publishable 2027 numbers.

### Can a 2027 file be created? No.
A 2027 file needs *every* number, and the IRS figures it depends on are still
not published on irs.gov:

- **IRS annual inflation-adjustment Revenue Procedure for tax year 2027** — not
  yet published. An irs.gov-scoped search returned only the 2026 procedure
  (Rev. Proc. 2025-32, https://www.irs.gov/pub/irs-drop/rp-25-32.pdf) and
  unrelated 2027-indexed items (HSA limits in Rev. Proc. 2026-24, §36B indexing
  in Rev. Proc. 2026-26). No 2027 brackets, standard deduction, or §199A QBI
  threshold exist on an official page. Per the job rules (stop if any number
  can't be confirmed), no 2027 file was created.
- **2027 standard mileage rate** — not published. The IRS standard-mileage page
  (https://www.irs.gov/tax-professionals/standard-mileage-rates), loaded
  directly, lists no 2027 rate; its newest entries are the two 2026 rates.

The SSA 2027 contribution and benefit base ($192,300, up from $184,500) appears
in search results from ssa.gov, but a single confirmed figure is not enough to
stand up a complete, correct year, and it isn't needed for an existing-year fix.

### Did any existing 2026 number change? No.
Confirmed on official pages actually loaded this run:

- **Standard mileage 2026** = 72.5¢ (Jan 1–Jun 30) and 76¢ (Jul 1–Dec 31), with
  the mid-year step-up already in the file. No further change.
  (https://www.irs.gov/tax-professionals/standard-mileage-rates)
- **NC flat rate** = 3.99% for tax years after 2025; page notes possible 2027
  trigger-based reductions but publishes no 2027 rate. Unchanged.
  (https://www.ncdor.gov/taxes-forms/individual-income-tax/tax-rate-schedules)
- **NC standard deduction** = $12,750 / $25,500 / $19,125. Unchanged.
  (https://www.ncdor.gov/taxes-forms/individual-income-tax/filing-topics/north-carolina-standard-deduction-or-north-carolina-itemized-deductions)
- Standard deduction, brackets, and §199A QBI threshold for 2026 remain those
  of Rev. Proc. 2025-32. Estimated-tax due dates for 2026 unchanged.

### Tests / build
- `npm test` — **29/29 passed**.
- `npm run build` — **succeeded** (production build, Vite).

### Deploy
No. Nothing changed in the tax year files, so per the job rules no deploy was
performed. No tax-number commit. (This log entry is the only repo change.)

### Blocked / notes
- Direct page loads of ssa.gov still return HTTP 403 (edge block on this IP), so
  the 2027 wage base was only seen via search snippets. This did not affect the
  outcome — no SSA number was written to any file this run.
