import PDFDocument from 'pdfkit';
import { branchGstState, indiaPlaceOfSupply, splitIndiaGst } from '../../common/india-gst';

export interface ReceiptPdfInput {
  restaurantName: string;
  branchName: string;
  address: string | null;
  phone: string | null;
  gstNumber: string | null;
  gstStateCode?: string | null;
  interstate?: boolean;
  currency: string;
  orderNumber: string;
  createdAt: Date;
  guestName: string | null;
  items: { name: string; quantity: number; lineTotal: number }[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  tipAmount: number;
  totalAmount: number;
  payments: { method: string; amount: number }[];
}

/** Paid-bill PDF. Figures are the ones already stored on the order. */
export function buildReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const money = (amount: number) => `${input.currency} ${Number(amount).toFixed(2)}`;
    doc.fontSize(16).text(input.restaurantName, { align: 'center' });
    doc.fontSize(10).text(input.branchName, { align: 'center' });
    if (input.address) doc.text(input.address, { align: 'center' });
    if (input.phone) doc.text(input.phone, { align: 'center' });
    if (input.gstNumber) doc.text(`GSTIN ${input.gstNumber}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Paid receipt', { align: 'center' });
    doc.fontSize(10).text(`Order ${input.orderNumber}`);
    doc.text(input.createdAt.toISOString());
    if (input.guestName) doc.text(input.guestName);
    doc.moveDown();
    for (const item of input.items) {
      doc.text(`${item.quantity} x ${item.name}  ${money(item.lineTotal)}`);
    }
    doc.moveDown();
    doc.text(`Subtotal ${money(input.subtotal)}`);
    if (input.discountAmount) doc.text(`Discount ${money(input.discountAmount)}`);
    if (input.taxAmount) {
      const supply = indiaPlaceOfSupply(branchGstState(input.gstStateCode, input.gstNumber), null);
      const split = splitIndiaGst(input.taxAmount, {
        interstate: !!input.interstate,
        intraUt: !input.interstate && supply.intraUt,
      });
      const india = input.currency.toUpperCase() === 'INR' && Boolean(input.gstNumber || input.gstStateCode);
      if (india && split.igst) doc.text(`IGST ${money(split.igst)}`);
      if (india && split.cgst) doc.text(`CGST ${money(split.cgst)}`);
      if (india && split.sgst) doc.text(`SGST ${money(split.sgst)}`);
      if (india && split.utgst) doc.text(`UTGST ${money(split.utgst)}`);
      if (!india) doc.text(`Tax ${money(input.taxAmount)}`);
    }
    if (input.tipAmount) doc.text(`Tip ${money(input.tipAmount)}`);
    doc.fontSize(12).text(`Total ${money(input.totalAmount)}`);
    doc.moveDown();
    for (const payment of input.payments) {
      doc.fontSize(10).text(`${payment.method} ${money(payment.amount)}`);
    }
    doc.moveDown();
    doc.text('Paid in full.');
    doc.end();
  });
}
