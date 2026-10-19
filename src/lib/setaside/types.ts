export type FilingStatus = 'single' | 'mfj' | 'hoh'

export type StateOption =
  | { kind: 'nc' }
  | { kind: 'none' }
  | { kind: 'other'; ratePct: number }

export interface Bracket {
  upTo: number
  rate: number
}

export interface TaxYearConfig {
  year: number
  ssWageBase: number
  ssRate: number
  medicareRate: number
  seEarningsFactor: number
  seMinimum: number
  addlMedicareRate: number
  addlMedicareThreshold: Record<FilingStatus, number>
  standardDeduction: Record<FilingStatus, number>
  brackets: Record<FilingStatus, Bracket[]>
  qbiRate: number
  qbiThreshold: Record<FilingStatus, number>
  nc: { rate: number; standardDeduction: Record<FilingStatus, number> }
  mileage: { from: string; to: string; centsPerMile: number }[]
  /** ISO dates (YYYY-MM-DD), in order. */
  estimatedDueDates: string[]
}
