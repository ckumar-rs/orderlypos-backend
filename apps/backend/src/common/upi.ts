// Same NPCI link as apps/web/lib/upi.ts. A QR of this string opens PhonePe,
// WhatsApp, or any other UPI app with the payee and amount filled in.
export function buildUpiUri(opts: {
  vpa: string;
  name?: string | null;
  amount: number;
  note?: string;
  ref?: string;
}): string {
  const q = new URLSearchParams();
  q.set('pa', opts.vpa);
  if (opts.name) q.set('pn', opts.name.slice(0, 60));
  if (opts.amount > 0) q.set('am', opts.amount.toFixed(2));
  q.set('cu', 'INR');
  if (opts.note) q.set('tn', opts.note.slice(0, 60));
  if (opts.ref) q.set('tr', opts.ref.slice(0, 35));
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}
