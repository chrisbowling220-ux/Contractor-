// 2026 federal + North Carolina numbers for the Safe-to-Spend calculator.
// Every figure was checked against the official source on 2026-10-19; the URL
// sits beside each one. When a new year's Rev. Proc. comes out, copy this file
// to taxYears/<year>.ts, update the numbers, and register it in taxYears/index.ts.
import type { TaxYearConfig } from '../types.ts'

const config: TaxYearConfig = {
  year: 2026,

  // Social Security contribution and benefit base for 2026.
  // https://www.ssa.gov/OACT/COLA/cbb.html
  ssWageBase: 184_500,

  // SE tax: 12.4% OASDI + 2.9% HI, on 92.35% of net earnings; none under $400.
  // https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes
  ssRate: 0.124,
  medicareRate: 0.029,
  seEarningsFactor: 0.9235,
  seMinimum: 400,

  // Additional Medicare Tax, 0.9% over the threshold (thresholds are statutory, not indexed).
  // https://www.irs.gov/taxtopics/tc560
  addlMedicareRate: 0.009,
  addlMedicareThreshold: { single: 200_000, mfj: 250_000, hoh: 200_000 },

  // Rev. Proc. 2025-32 §.14 (standard deduction) and §.01 Tables 1–3 (brackets).
  // https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
  standardDeduction: { single: 16_100, mfj: 32_200, hoh: 24_150 },
  brackets: {
    single: [
      { upTo: 12_400, rate: 0.10 },
      { upTo: 50_400, rate: 0.12 },
      { upTo: 105_700, rate: 0.22 },
      { upTo: 201_775, rate: 0.24 },
      { upTo: 256_225, rate: 0.32 },
      { upTo: 640_600, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
    mfj: [
      { upTo: 24_800, rate: 0.10 },
      { upTo: 100_800, rate: 0.12 },
      { upTo: 211_400, rate: 0.22 },
      { upTo: 403_550, rate: 0.24 },
      { upTo: 512_450, rate: 0.32 },
      { upTo: 768_700, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
    hoh: [
      { upTo: 17_700, rate: 0.10 },
      { upTo: 67_450, rate: 0.12 },
      { upTo: 105_700, rate: 0.22 },
      { upTo: 201_750, rate: 0.24 },
      { upTo: 256_200, rate: 0.32 },
      { upTo: 640_600, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
  },

  // §199A QBI deduction, 20%, made permanent by OBBBA. Threshold from
  // Rev. Proc. 2025-32 §.26 ("All other returns" covers single and HoH).
  // https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
  qbiRate: 0.20,
  qbiThreshold: { single: 201_750, mfj: 403_500, hoh: 201_750 },

  // NC flat rate for tax years after 2025: 3.99%.
  // https://www.ncdor.gov/taxes-forms/tax-rate-schedules
  // NC standard deduction (unchanged from 2025; NCDOR has not published a
  // different 2026 amount): https://www.ncdor.gov/taxes-forms/individual-income-tax/north-carolina-standard-deduction-or-north-carolina-itemized-deductions
  nc: {
    rate: 0.0399,
    standardDeduction: { single: 12_750, mfj: 25_500, hoh: 19_125 },
  },

  // Business standard mileage rate: 72.5¢ Jan 1–Jun 30 (IR-2025-128),
  // 76¢ from Jul 1 (IR-2026-29 / Announcement 2026-11, IRB 2026-29).
  // https://www.irs.gov/tax-professionals/standard-mileage-rates
  mileage: [
    { from: '2026-01-01', to: '2026-06-30', centsPerMile: 72.5 },
    { from: '2026-07-01', to: '2026-12-31', centsPerMile: 76 },
  ],

  // Estimated tax due dates for the 2026 tax year.
  // https://www.irs.gov/faqs/estimated-tax/individuals/individuals-2
  estimatedDueDates: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
}

export default config
