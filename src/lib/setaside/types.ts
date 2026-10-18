export type FilingStatus = 'single' | 'mfj' | 'hoh';
export type StateOption = 'NC' | 'none' | 'other';
export type Bracket = readonly [upper: number, rate: number];
export interface TaxYearConfig {
  year: number;
  socialSecurityWageBase: number;
  seMultiplier: number;
  seMinimum: number;
  socialSecurityRate: number;
  medicareRate: number;
  deductibleSEFraction: number;
  additionalMedicareRate: number;
  additionalMedicareThreshold: Record<FilingStatus, number>;
  standardDeduction: Record<FilingStatus, number>;
  brackets: Record<FilingStatus, readonly Bracket[]>;
  qbiThreshold: Record<FilingStatus, number>;
  qbiRate: number;
  ncRate: number;
  ncStandardDeduction: Record<FilingStatus, number>;
  dueDates: readonly string[];
  mileage: readonly { from: string; through: string; cents: number }[];
}
export interface AnnualInput {
  net: number;
  filingStatus: FilingStatus;
  state: StateOption;
  otherIncome?: number;
  /** Only THIS contractor's W-2 Social Security wages, never the spouse's. */
  ownSocialSecurityWages?: number;
  /** W-2 Medicare wages of both spouses when MFJ. Already included in otherIncome. */
  householdMedicareWages?: number;
  otherStatePercent?: number;
}
