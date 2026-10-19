import type { TaxYearConfig } from '../types'
import tax2026 from './2026'

// Registered tax years. The 2027 inflation numbers weren't published on irs.gov
// as of 2026-10-19, so only 2026 ships; add 2027 here once Rev. Proc. is out.
export const TAX_YEARS: Record<number, TaxYearConfig> = {
  2026: tax2026,
}

/** Config for the calendar year of `today`, else the newest one we have. */
export function taxYearFor(today: Date): TaxYearConfig {
  const exact = TAX_YEARS[today.getFullYear()]
  if (exact) return exact
  const years = Object.keys(TAX_YEARS).map(Number).sort((a, b) => a - b)
  return TAX_YEARS[years[years.length - 1]]
}
