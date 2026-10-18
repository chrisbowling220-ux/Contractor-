import type { TaxYearConfig } from '../types';

/** Verified 2026-10-18 against the official sources below. All values are USD. */
export const tax2026: TaxYearConfig = {
  year: 2026,
  // https://www.ssa.gov/oact/cola/cbb.html
  socialSecurityWageBase: 184_500,
  // https://www.irs.gov/instructions/i1040sse
  seMultiplier: 0.9235,
  seMinimum: 400,
  socialSecurityRate: 0.124,
  medicareRate: 0.029,
  deductibleSEFraction: 0.5,
  // https://www.irs.gov/instructions/i8959 — not indexed; NOT deductible.
  additionalMedicareRate: 0.009,
  additionalMedicareThreshold: { single: 200_000, mfj: 250_000, hoh: 200_000 },
  // https://www.irs.gov/pub/irs-drop/rp-25-32.pdf sections 4.01, 4.14, 4.26
  standardDeduction: { single: 16_100, mfj: 32_200, hoh: 24_150 },
  brackets: {
    single: [[12_400, .10], [50_400, .12], [105_700, .22], [201_775, .24], [256_225, .32], [640_600, .35], [Infinity, .37]],
    mfj: [[24_800, .10], [100_800, .12], [211_400, .22], [403_550, .24], [512_450, .32], [768_700, .35], [Infinity, .37]],
    hoh: [[17_700, .10], [67_450, .12], [105_700, .22], [201_750, .24], [256_200, .32], [640_600, .35], [Infinity, .37]],
  },
  qbiThreshold: { single: 201_750, mfj: 403_500, hoh: 201_750 },
  // https://www.irs.gov/newsroom/qualified-business-income-deduction
  // Simplified conservative model; excludes special $400 active-business minimum.
  qbiRate: 0.20,
  // https://www.ncdor.gov/taxes-forms/individual-income-tax/tax-rate-schedules
  ncRate: 0.0399,
  // https://www.ncdor.gov/taxes-forms/individual-income-tax/filing-topics/north-carolina-standard-deduction-or-north-carolina-itemized-deductions
  ncStandardDeduction: { single: 12_750, mfj: 25_500, hoh: 19_125 },
  // https://www.irs.gov/pub/irs-pdf/f1040es.pdf
  dueDates: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
  // https://www.irs.gov/tax-professionals/standard-mileage-rates
  // https://www.irs.gov/irb/2026-29_irb — Announcement 2026-11
  mileage: [{ from: '2026-01-01', through: '2026-06-30', cents: 72.5 }, { from: '2026-07-01', through: '2026-12-31', cents: 76 }],
};
