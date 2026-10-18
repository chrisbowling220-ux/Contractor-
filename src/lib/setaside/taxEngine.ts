import { tax2026 } from './taxYears/2026';
import type { AnnualInput, Bracket, TaxYearConfig } from './types';

function nonnegative(value = 0): number {
  if (!Number.isFinite(value)) throw new RangeError('Amounts must be finite.');
  return Math.max(0, value);
}
export const roundCents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function bracketTax(taxable: number, brackets: readonly Bracket[]): number {
  let total = 0, lower = 0;
  for (const [upper, rate] of brackets) {
    total += Math.max(0, Math.min(taxable, upper) - lower) * rate;
    if (taxable <= upper) break;
    lower = upper;
  }
  return total;
}

/** Incremental tax on this business. No intermediate rounding; no credits/withholding. */
export function calculateAnnual(input: AnnualInput, config: TaxYearConfig = tax2026) {
  const net = nonnegative(input.net);
  const other = nonnegative(input.otherIncome);
  const ownWages = nonnegative(input.ownSocialSecurityWages);
  const householdWages = nonnegative(input.householdMedicareWages);
  const statePercent = nonnegative(input.otherStatePercent);
  if (statePercent > 100) throw new RangeError('State rate must be between 0 and 100.');
  const status = input.filingStatus;
  const candidate = net * config.seMultiplier;
  const seBase = candidate < config.seMinimum ? 0 : candidate;
  const socialSecurity = config.socialSecurityRate * Math.min(seBase, Math.max(0, config.socialSecurityWageBase - ownWages));
  const medicare = config.medicareRate * seBase;
  // Form 8959 Part II: allocate only the incremental tax on SE earnings here.
  // https://www.irs.gov/instructions/i8959
  const remainingMedicareThreshold = Math.max(0, config.additionalMedicareThreshold[status] - householdWages);
  const additionalMedicare = config.additionalMedicareRate * Math.max(0, seBase - remainingMedicareThreshold);
  const selfEmployment = socialSecurity + medicare;
  const halfSE = selfEmployment * config.deductibleSEFraction;
  const federalSide = (business: number, deduction: number) => {
    const agi = other + business - deduction;
    const preQBI = Math.max(0, agi - config.standardDeduction[status]);
    const qbiLimited = business > 0 && preQBI > config.qbiThreshold[status];
    const qbi = qbiLimited ? 0 : Math.max(0, Math.min(config.qbiRate * (business - deduction), config.qbiRate * preQBI));
    return { agi, preQBI, qbi, qbiLimited, tax: bracketTax(Math.max(0, preQBI - qbi), config.brackets[status]) };
  };
  const withSE = federalSide(net, halfSE);
  const withoutSE = federalSide(0, 0);
  const federal = Math.max(0, withSE.tax - withoutSE.tax);
  const ncTax = (agi: number) => Math.max(0, agi - config.ncStandardDeduction[status]) * config.ncRate;
  const state = input.state === 'NC' ? Math.max(0, ncTax(withSE.agi) - ncTax(withoutSE.agi)) : input.state === 'other' ? statePercent / 100 * net : 0;
  const totalTax = selfEmployment + additionalMedicare + federal + state;
  const exactRate = net > 0 ? totalTax / net : 0;
  const roundedRate = Math.max(0, Math.ceil(exactRate * 100 - 1e-10) / 100);
  const setAside = roundCents(roundedRate * net);
  return { net, seBase, socialSecurity, medicare, additionalMedicare, selfEmployment, halfSE, federal, state, totalTax, exactRate, roundedRate, setAside,
    yoursToSpend: roundCents(input.net - setAside), qbi: withSE.qbi, qbiLimited: withSE.qbiLimited,
    qbiThreshold: config.qbiThreshold[status], preQBI: withSE.preQBI,
    roundingBuffer: setAside - totalTax };
}

export function calculatePayment(payment: number, materials: number, annualInput: AnnualInput, config: TaxYearConfig = tax2026) {
  payment = nonnegative(payment); materials = nonnegative(materials);
  const annual = calculateAnnual(annualInput, config);
  const profit = Math.max(0, payment - materials);
  const setAside = roundCents(annual.roundedRate * profit);
  const scale = annual.net > 0 ? profit / annual.net : 0;
  return { annual, profit, coveringCosts: materials, setAside, yoursToSpend: roundCents(payment - materials - setAside),
    selfEmployment: annual.selfEmployment * scale, additionalMedicare: annual.additionalMedicare * scale,
    federal: annual.federal * scale, state: annual.state * scale, roundingBuffer: setAside - annual.totalTax * scale };
}

/** ISO local calendar dates avoid UTC-midnight rollover surprises. */
export function nextDueDate(today: string, configs: readonly TaxYearConfig[] = [tax2026]): string | null {
  return configs.flatMap(c => [...c.dueDates]).sort().find(date => date >= today) ?? null;
}
export function selectTaxYear(today: string, configs: readonly TaxYearConfig[] = [tax2026]) {
  const year = Number(today.slice(0, 4));
  const exact = configs.find(c => c.year === year);
  const config = exact ?? [...configs].sort((a, b) => b.year - a.year)[0];
  return { config, isCurrent: Boolean(exact) };
}
export function annualNetBucket(net: number): string {
  if (net <= 0) return '0';
  if (net < 25_000) return 'under-25k';
  if (net < 50_000) return '25-50k';
  if (net < 100_000) return '50-100k';
  if (net < 200_000) return '100-200k';
  return '200k+';
}
export function parseMoney(value: string): number | null {
  const clean = value.trim().replace(/[$,]/g, '');
  if (clean === '') return 0;
  if (!/^\d{1,10}(\.\d{0,2})?$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isFinite(number) && number <= 1_000_000_000 ? number : null;
}
