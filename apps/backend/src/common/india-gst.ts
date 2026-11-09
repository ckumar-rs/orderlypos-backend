import { round2 } from '../modules/accounting/accounting.calc';

// Place-of-supply rules used on an Indian tax invoice.
// Intra-state is CGST + SGST. The five union territories without a legislature
// use CGST + UTGST instead. A different state code is IGST.
// GSTIN prefixes 28 and 25 are the old Andhra Pradesh and Daman & Diu codes.
const LEGACY_STATE_CODE: Record<string, string> = { '28': '37', '25': '26' };
const UNION_TERRITORY_WITHOUT_LEGISLATURE = new Set(['04', '26', '31', '35', '38']);

export function gstStateCode(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (/^\d{2}[A-Za-z0-9]{13}$/.test(raw)) {
    const prefix = raw.slice(0, 2);
    return LEGACY_STATE_CODE[prefix] ?? prefix;
  }
  if (/^\d{1,2}$/.test(raw)) {
    const code = raw.padStart(2, '0');
    return LEGACY_STATE_CODE[code] ?? code;
  }
  return '';
}

export function isUnionTerritoryWithoutLegislature(stateCode: string | null | undefined): boolean {
  const code = gstStateCode(stateCode);
  return Boolean(code) && UNION_TERRITORY_WITHOUT_LEGISLATURE.has(code);
}

/** Saved state code, or the first two digits of the GSTIN when the code is blank. */
export function branchGstState(
  stateCode: string | null | undefined,
  gstin: string | null | undefined,
): string {
  return gstStateCode(stateCode) || gstStateCode(gstin);
}

export interface IndiaSupply {
  businessCode: string;
  placeCode: string;
  interstate: boolean;
  intraUt: boolean;
}

/** Guest state wins as place of supply. A blank guest stays intra-state. */
export function indiaPlaceOfSupply(
  branchStateOrGstin: string | null | undefined,
  guestStateOrGstin: string | null | undefined,
): IndiaSupply {
  const businessCode = gstStateCode(branchStateOrGstin);
  const placeCode = gstStateCode(guestStateOrGstin);
  const interstate = Boolean(businessCode && placeCode && businessCode !== placeCode);
  return {
    businessCode,
    placeCode,
    interstate,
    intraUt: !interstate && isUnionTerritoryWithoutLegislature(businessCode),
  };
}

export interface IndiaTaxSplit {
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
}

/** Odd paisa stays on SGST or UTGST so the heads add back to the tax. */
export function splitIndiaGst(
  tax: number,
  supply: Pick<IndiaSupply, 'interstate' | 'intraUt'>,
): IndiaTaxSplit {
  const amount = round2(tax);
  if (supply.interstate) return { cgst: 0, sgst: 0, utgst: 0, igst: amount };
  const cgst = Math.round(amount * 50) / 100;
  const other = round2(amount - cgst);
  if (supply.intraUt) return { cgst, sgst: 0, utgst: other, igst: 0 };
  return { cgst, sgst: other, utgst: 0, igst: 0 };
}

/** Tax already inside an inclusive price, rounded on the line the way a tax invoice does. */
export function inclusiveGstLine(charged: number, ratePercent: number): { taxable: number; tax: number } {
  if (!(ratePercent > 0) || !(charged > 0)) return { taxable: round2(Math.max(0, charged)), tax: 0 };
  const taxableRaw = charged / (1 + ratePercent / 100);
  return { taxable: round2(taxableRaw), tax: round2((taxableRaw * ratePercent) / 100) };
}

/** Tax added on top of an exclusive price. */
export function exclusiveGstLine(charged: number, ratePercent: number): { taxable: number; tax: number } {
  if (!(charged > 0)) return { taxable: 0, tax: 0 };
  if (!(ratePercent > 0)) return { taxable: round2(charged), tax: 0 };
  return {
    taxable: round2(charged),
    tax: round2((charged * ratePercent) / 100),
  };
}

export function gstLine(
  charged: number,
  ratePercent: number,
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE' = 'INCLUSIVE',
): { taxable: number; tax: number } {
  return taxMode === 'EXCLUSIVE'
    ? exclusiveGstLine(charged, ratePercent)
    : inclusiveGstLine(charged, ratePercent);
}
