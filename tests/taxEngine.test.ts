import { describe, expect, it } from 'vitest';
import { annualNetBucket, bracketTax, calculateAnnual, calculatePayment, nextDueDate, parseMoney, roundCents, selectTaxYear } from '../src/lib/setaside/taxEngine';
import { tax2026 } from '../src/lib/setaside/taxYears/2026';
import type { AnnualInput } from '../src/lib/setaside/types';

const base: AnnualInput = { net: 50_000, filingStatus: 'single', state: 'NC' };
describe('2026 tax engine', () => {
  it('matches the independently specified $50k NC example without intermediate rounding', () => {
    const r = calculateAnnual(base);
    expect(r.selfEmployment).toBeCloseTo(7064.775, 8);
    expect(roundCents(r.selfEmployment)).toBe(7064.78);
    expect(r.federal).toBeCloseTo(2667.29, 2);
    expect(r.state).toBeCloseTo(1345.33, 2);
    expect(r.totalTax).toBeCloseTo(11077.40, 2);
    expect(r.exactRate * 100).toBeCloseTo(22.15, 2);
    expect(r.roundedRate).toBe(.23);
    expect(r.setAside).toBe(11500);
  });
  it.each([0, -5000])('never creates a tax or a refund from %s net', net => {
    const r = calculateAnnual({ ...base, net, otherIncome: 300000, householdMedicareWages: 300000 });
    expect(r.totalTax).toBe(0); expect(r.roundedRate).toBe(0); expect(r.yoursToSpend).toBe(net);
  });
  it('applies the $400 test to adjusted SE earnings', () => {
    expect(calculateAnnual({ ...base, net: 400 }).selfEmployment).toBe(0);
    expect(calculateAnnual({ ...base, net: 433 }).selfEmployment).toBe(0);
    expect(calculateAnnual({ ...base, net: 434 }).selfEmployment).toBeCloseTo(61.322247, 6);
    expect(calculateAnnual({ ...base, net: 400, otherIncome: 100000 }).federal).toBeGreaterThan(0);
  });
  it('caps Social Security and keeps Medicare running above the wage base', () => {
    const r = calculateAnnual({ ...base, net: 300000 });
    expect(r.socialSecurity).toBe(22878);
    expect(r.medicare).toBeCloseTo(8034.45, 5);
    expect(r.additionalMedicare).toBeCloseTo(693.45, 5);
    expect(r.halfSE).toBe((r.socialSecurity + r.medicare) / 2);
    expect(r.qbiLimited).toBe(true);
  });
  it('uses separate MFJ deductions and brackets', () => {
    const r = calculateAnnual({ ...base, filingStatus: 'mfj' });
    expect(r.federal).toBeCloseTo(1141.409, 5);
    expect(r.state).toBeCloseTo(836.60773875, 5);
    expect(r.qbiThreshold).toBe(403500);
  });
  it('uses exact HoH deductions and bracket boundaries', () => {
    const r = calculateAnnual({ ...base, filingStatus: 'hoh' });
    expect(r.federal).toBeCloseTo(1788.4908, 5);
    expect(r.state).toBeCloseTo(1090.97023875, 5);
    expect(bracketTax(201750, tax2026.brackets.hoh)).toBeCloseTo(39207, 6);
  });
  it('applies an Other flat state rate to profit and supports no state tax', () => {
    expect(calculateAnnual({ ...base, state: 'other', otherStatePercent: 5.5 }).state).toBe(2750);
    expect(calculateAnnual({ ...base, state: 'none' }).state).toBe(0);
  });
  it('subtracts only the contractor’s own Social Security wages from the cap', () => {
    const r = calculateAnnual({ ...base, otherIncome: 180000, ownSocialSecurityWages: 180000, householdMedicareWages: 180000 });
    expect(r.socialSecurity).toBe(558);
    const spouseOnly = calculateAnnual({ ...base, filingStatus: 'mfj', otherIncome: 180000, householdMedicareWages: 180000 });
    expect(spouseOnly.socialSecurity).toBeCloseTo(5725.7, 5);
  });
  it('does not allocate wage-only Additional Medicare tax to business income', () => {
    const r = calculateAnnual({ ...base, otherIncome: 300000, ownSocialSecurityWages: 184500, householdMedicareWages: 300000 });
    expect(r.socialSecurity).toBe(0);
    expect(r.additionalMedicare).toBeCloseTo(415.575, 5);
  });
  it('uses a WITH versus WITHOUT business comparison for income taxes', () => {
    const r = calculateAnnual({ ...base, net: 10000, otherIncome: 100000 });
    expect(r.federal).toBeCloseTo(1635.660, 2);
    expect(r.state).toBeCloseTo((10000 - r.halfSE) * .0399, 6);
  });
  it('uses QBI up to the inclusive threshold and omits it above', () => {
    const ownSocialSecurityWages = 184500;
    const net = 1000;
    const halfSE = net * .9235 * .029 / 2;
    const otherIncome = 201750 + 16100 - net + halfSE;
    expect(calculateAnnual({ ...base, net, ownSocialSecurityWages, otherIncome }).qbiLimited).toBe(false);
    expect(calculateAnnual({ ...base, net, ownSocialSecurityWages, otherIncome: otherIncome + .01 }).qbi).toBe(0);
  });
  it('reserves $345 from $2,000 less $500 costs', () => {
    const r = calculatePayment(2000, 500, base);
    expect(r.setAside).toBe(345); expect(r.yoursToSpend).toBe(1155); expect(r.coveringCosts).toBe(500);
    expect(r.selfEmployment + r.additionalMedicare + r.federal + r.state + r.roundingBuffer).toBeCloseTo(345, 8);
  });
  it('exposes a loss on a job rather than inventing spendable money', () => {
    const r = calculatePayment(100, 200, base);
    expect(r.setAside).toBe(0); expect(r.yoursToSpend).toBe(-100);
  });
  it('handles due-day inclusivity, year-end and the end of verified dates', () => {
    expect(nextDueDate('2026-06-15')).toBe('2026-06-15');
    expect(nextDueDate('2026-06-16')).toBe('2026-09-15');
    expect(nextDueDate('2026-10-18')).toBe('2027-01-15');
    expect(nextDueDate('2027-01-15')).toBe('2027-01-15');
    expect(nextDueDate('2027-01-16')).toBeNull();
    expect(selectTaxYear('2027-01-01').isCurrent).toBe(false);
  });
  it('rejects nonfinite amounts and unreasonable rates', () => {
    expect(() => calculateAnnual({ ...base, net: NaN })).toThrow();
    expect(() => calculateAnnual({ ...base, otherStatePercent: 101 })).toThrow();
  });
  it('validates text amounts and buckets only ranges', () => {
    expect(parseMoney('$50,000.25')).toBe(50000.25); expect(parseMoney('')).toBe(0);
    expect(parseMoney('-10')).toBeNull(); expect(parseMoney('1e5')).toBeNull();
    expect(parseMoney('abc')).toBeNull(); expect(annualNetBucket(37500)).toBe('25-50k');
  });
});
