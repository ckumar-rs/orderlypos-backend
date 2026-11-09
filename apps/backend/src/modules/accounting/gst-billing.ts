import { gstSummary, round2 } from './accounting.calc';
import { branchGstState, gstLine, indiaPlaceOfSupply, splitIndiaGst } from '../../common/india-gst';

export type GstSupply = 'INTRA' | 'INTER';
export type GstDocumentKind = 'TAX_INVOICE' | 'BILL_OF_SUPPLY';

export interface GstBillLine {
  name: string;
  hsnCode: string | null;
  quantity: number;
  lineTotal: number;
  taxRatePercent: number;
}

export interface GstBillInput {
  orderNumber: string;
  billedAt: string;
  guestName: string | null;
  guestState: string | null;
  subtotal: number;
  discountAmount: number;
  loyaltyDiscountAmount: number;
  lines: GstBillLine[];
  refunds: { amount: number; createdAt: string }[];
}

export interface GstRequirement {
  id: string;
  done: boolean;
  label: string;
  detail: string;
}

/** Same state, or a guest with no state, is CGST and SGST. A union territory without a legislature uses UTGST instead of SGST. A different guest state is IGST. */
export function supplyKind(branchState: string | null, guestState: string | null): GstSupply {
  return indiaPlaceOfSupply(branchState, guestState).interstate ? 'INTER' : 'INTRA';
}

export function splitGst(tax: number, supply: GstSupply): { cgst: number; sgst: number; igst: number } {
  const split = splitIndiaGst(tax, { interstate: supply === 'INTER', intraUt: false });
  return { cgst: split.cgst, sgst: split.sgst, igst: split.igst };
}

function chargedShare(bill: GstBillInput): number {
  if (!(bill.subtotal > 0)) return 1;
  const charged = bill.subtotal - bill.discountAmount - bill.loyaltyDiscountAmount;
  return Math.max(0, charged) / bill.subtotal;
}

export function planGstBilling(
  branchState: string | null,
  bills: GstBillInput[],
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE' = 'INCLUSIVE',
) {
  const documents = bills.map((bill) => {
    const factor = chargedShare(bill);
    let taxable = 0;
    let tax = 0;
    for (const line of bill.lines) {
      const part = gstLine(line.lineTotal * factor, line.taxRatePercent, taxMode);
      taxable += part.taxable;
      tax += part.tax;
    }
    const place = indiaPlaceOfSupply(branchState, bill.guestState);
    const split = splitIndiaGst(tax, place);
    return {
      orderNumber: bill.orderNumber,
      billedAt: bill.billedAt,
      guestName: bill.guestName,
      kind: (round2(tax) > 0 ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY') as GstDocumentKind,
      supply: (place.interstate ? 'INTER' : 'INTRA') as GstSupply,
      taxable: round2(taxable),
      tax: round2(tax),
      ...split,
      total: round2(taxable + tax),
    };
  });

  const hsn = new Map<string, { taxable: number; tax: number }>();
  const summaryLines: { lineTotal: number; taxRatePercent: number; factor: number }[] = [];
  let missingHsn = 0;
  let lineCount = 0;
  for (const bill of bills) {
    const factor = chargedShare(bill);
    for (const line of bill.lines) {
      lineCount += 1;
      const key = line.hsnCode?.trim() || 'Missing';
      if (key === 'Missing') missingHsn += 1;
      const part = gstLine(line.lineTotal * factor, line.taxRatePercent, taxMode);
      const row = hsn.get(key) ?? { taxable: 0, tax: 0 };
      row.taxable += part.taxable;
      row.tax += part.tax;
      hsn.set(key, row);
      summaryLines.push({ lineTotal: line.lineTotal, taxRatePercent: line.taxRatePercent, factor });
    }
  }

  const creditNotes = bills.flatMap((bill, index) => {
    const doc = documents[index];
    const place = indiaPlaceOfSupply(branchState, bill.guestState);
    return bill.refunds
      .filter((refund) => refund.amount > 0)
      .map((refund) => {
        const share = doc.total > 0 ? Math.min(1, refund.amount / doc.total) : 0;
        const split = splitIndiaGst(doc.tax * share, place);
        return {
          orderNumber: bill.orderNumber,
          amount: round2(refund.amount),
          createdAt: refund.createdAt,
          taxable: round2(doc.taxable * share),
          ...split,
        };
      });
  });

  return {
    documents,
    creditNotes,
    missingHsn,
    lineCount,
    hsn: [...hsn.entries()]
      .map(([code, row]) => ({
        code,
        taxable: round2(row.taxable),
        tax: round2(row.tax),
        total: round2(row.taxable + row.tax),
      }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    rates: gstSummary(summaryLines, taxMode),
    cgst: round2(documents.reduce((sum, doc) => sum + doc.cgst, 0)),
    sgst: round2(documents.reduce((sum, doc) => sum + doc.sgst, 0)),
    utgst: round2(documents.reduce((sum, doc) => sum + doc.utgst, 0)),
    igst: round2(documents.reduce((sum, doc) => sum + doc.igst, 0)),
    taxMode,
  };
}

export function gstRequirements(input: {
  gstin: string | null;
  stateCode: string | null;
  missingHsn: number;
  lineCount: number;
}): GstRequirement[] {
  return [
    {
      id: 'gstin',
      done: Boolean(input.gstin?.trim()),
      label: 'Branch GSTIN',
      detail: 'The GSTIN on the branch is printed on the paid receipt.',
    },
    {
      id: 'state',
      done: Boolean(branchGstState(input.stateCode, input.gstin)),
      label: 'Branch GST state',
      detail: 'A two-character state code, or the first two digits of the GSTIN. A guest with another code is IGST. Chandigarh, Ladakh, Andaman and Nicobar, Lakshadweep, and Dadra and Nagar Haveli and Daman and Diu use UTGST instead of SGST.',
    },
    {
      id: 'hsn',
      done: input.lineCount === 0 || input.missingHsn === 0,
      label: 'HSN on sold dishes',
      detail:
        input.missingHsn > 0
          ? `${input.missingHsn} sold lines in this range have no HSN.`
          : 'Every sold line in this range has an HSN.',
    },
    {
      id: 'b2b',
      done: false,
      label: 'Guest GSTIN for B2B',
      detail: 'A customer record has a state code and no GSTIN, so these bills stay B2C. Use GSTR-1 JSON for B2C/HSN portal handoff.',
    },
  ];
}
