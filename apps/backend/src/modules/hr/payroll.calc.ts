// Pure payroll maths, kept separate from the database code so it can be
// unit-tested. All money is in major units (e.g. rupees), rounded to 2 dp.

export const round2 = (n: number) =>
  Math.round((n + Number.EPSILON) * 100) / 100;

export interface PayInput {
  userId: string;
  payType: 'MONTHLY' | 'HOURLY';
  rate: number;
  hoursWorked: number;
  /** Approved UNPAID leave days that fall inside the period. */
  unpaidLeaveDays: number;
}

export interface PayLineResult {
  userId: string;
  hoursWorked: number;
  basePay: number;
  tipShare: number;
  unpaidLeaveDeduction: number;
  pfEmployee: number;
  pfEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  tds: number;
  netPay: number;
}

export interface StatutoryInput {
  /** Full-month gross used for ESI eligibility and annualising TDS. */
  monthlyGross: number;
  /** Money earned in this payroll period, before statutory deductions. */
  periodGross: number;
  periodDays: number;
  monthDays: number;
}

const PF_RATE = 0.12;
const PF_WAGE_CEILING = 15_000;
const ESI_GROSS_LIMIT = 21_000;
const ESI_EMPLOYEE = 0.0075;
const ESI_EMPLOYER = 0.0325;
const STANDARD_DEDUCTION = 75_000;
const REBATE_INCOME = 1_200_000;

/**
 * India payroll estimate for a draft run. PF is 12% employee and 12%
 * employer on basic wages, capped at the ₹15,000 statutory ceiling,
 * pro-rated for a short period. ESI applies when the full-month gross is
 * ₹21,000 or less. TDS is the new-regime monthly share (Budget 2025
 * slabs, ₹75,000 standard deduction, rebate up to ₹12 lakh, 4% cess).
 * It is a draft figure for the till, not a filed return.
 */
export function indiaStatutory(input: StatutoryInput) {
  const earned = Math.max(input.periodGross, 0);
  const monthShare =
    input.monthDays > 0 ? input.periodDays / input.monthDays : 1;
  const pfWage = Math.min(earned, round2(PF_WAGE_CEILING * monthShare));
  const pfEmployee = round2(pfWage * PF_RATE);
  const pfEmployer = pfEmployee;
  const esiApplies = input.monthlyGross > 0 && input.monthlyGross <= ESI_GROSS_LIMIT;
  const esiEmployee = esiApplies ? round2(earned * ESI_EMPLOYEE) : 0;
  const esiEmployer = esiApplies ? round2(earned * ESI_EMPLOYER) : 0;
  const annual = round2(Math.max(input.monthlyGross, 0) * 12);
  const annualTax = annual <= REBATE_INCOME ? 0 : incomeTax(annual - STANDARD_DEDUCTION);
  const tds = round2((annualTax / 12) * monthShare);
  return { pfEmployee, pfEmployer, esiEmployee, esiEmployer, tds };
}

function incomeTax(taxable: number): number {
  if (taxable <= 0) return 0;
  const bands: [number, number][] = [
    [400_000, 0],
    [400_000, 0.05],
    [400_000, 0.1],
    [400_000, 0.15],
    [400_000, 0.2],
    [400_000, 0.25],
    [Number.POSITIVE_INFINITY, 0.3],
  ];
  let left = taxable;
  let tax = 0;
  for (const [width, rate] of bands) {
    const slice = Math.min(left, width);
    tax += slice * rate;
    left -= slice;
    if (left <= 0) break;
  }
  return round2(tax * 1.04);
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daysInclusive(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function daysInMonthOf(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * MONTHLY staff earn rate x (period days / days in the period's first
 * month), so a full calendar month pays exactly the rate. UNPAID leave
 * deducts a day's pay (rate / days in month) per day. HOURLY staff earn
 * rate x clocked hours and have no leave deduction (unpaid by nature).
 *
 * The tip pool is split in proportion to hours worked; the last recipient
 * absorbs rounding so the shares always add up to the pool exactly.
 */
export function computePayroll(
  periodStart: string,
  periodEnd: string,
  tipPool: number,
  staff: PayInput[],
  statutory = false,
): PayLineResult[] {
  const periodDays = daysInclusive(periodStart, periodEnd);
  const monthDays = daysInMonthOf(periodStart);
  const totalHours = staff.reduce((s, p) => s + p.hoursWorked, 0);

  const tipRecipients = staff.filter((p) => p.hoursWorked > 0);
  const tips = new Map<string, number>();
  if (tipPool > 0 && totalHours > 0) {
    let allocated = 0;
    tipRecipients.forEach((p, i) => {
      const share =
        i === tipRecipients.length - 1
          ? round2(tipPool - allocated)
          : round2((tipPool * p.hoursWorked) / totalHours);
      allocated = round2(allocated + share);
      tips.set(p.userId, share);
    });
  }

  return staff.map((p) => {
    const hours = round2(p.hoursWorked);
    let basePay: number;
    let deduction = 0;
    if (p.payType === 'HOURLY') {
      basePay = round2(p.rate * p.hoursWorked);
    } else {
      basePay = round2((p.rate * periodDays) / monthDays);
      deduction = round2((p.rate / monthDays) * p.unpaidLeaveDays);
    }
    const tipShare = tips.get(p.userId) ?? 0;
    const earned = round2(basePay - deduction);
    const deductions = statutory
      ? indiaStatutory({
          monthlyGross: p.payType === 'HOURLY' ? round2((earned * monthDays) / periodDays) : p.rate,
          periodGross: earned,
          periodDays,
          monthDays,
        })
      : { pfEmployee: 0, pfEmployer: 0, esiEmployee: 0, esiEmployer: 0, tds: 0 };
    const employeeStatutory = round2(
      deductions.pfEmployee + deductions.esiEmployee + deductions.tds,
    );
    return {
      userId: p.userId,
      hoursWorked: hours,
      basePay,
      tipShare,
      unpaidLeaveDeduction: deduction,
      ...deductions,
      netPay: round2(Math.max(0, earned + tipShare - employeeStatutory)),
    };
  });
}
