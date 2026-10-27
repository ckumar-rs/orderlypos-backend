// Pure VERI*FACTU building blocks (Spain, RD 1007/2023, Orden HAC/1177/2024): the record fingerprint
// (huella), the verification QR URL, the AEAT XML records and the tax breakdown. Ported from Rechvix's
// verifactu domain package; the hash vectors in verifactu.domain.spec.ts are AEAT's own worked examples
// (hash specification v0.1.2, QR specification v0.5.0). Money is integer cents throughout so no float
// rounding can move a total.
import { createHash } from 'node:crypto';

export type VerifactuEnvironment = 'TEST' | 'PRODUCTION';

const QR_BASE: Record<VerifactuEnvironment, string> = {
  TEST: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR',
  PRODUCTION: 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR',
};

export const QR_HEADING = 'QR tributario:';
export const QR_VERIFIABLE =
  'Factura verificable en la sede electrónica de la AEAT';
export const QR_SHORT = 'VERI*FACTU';

export const NS_INFO =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd';
export const NS_LR =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd';

/** IVA rates (percent) that can appear on a Spanish invoice; anything else is refused rather than guessed. */
export const IVA_RATES = [0, 2, 4, 5, 7.5, 10, 21] as const;

export interface InvoiceId {
  issuerNif: string;
  number: string;
  /** Issue date in Europe/Madrid as dd-MM-yyyy. */
  issueDate: string;
}

export interface BreakdownLine {
  /** 0, 4, 10, 21... percent. */
  rate: number;
  baseCents: number;
  quotaCents: number;
}

export interface SystemInfo {
  producerName: string;
  producerCountry: string;
  producerIdType: string;
  producerId: string;
  systemName: string;
  systemId: string;
  version: string;
  installationNumber: string;
}

export interface ChainRef extends InvoiceId {
  hash: string;
}

export interface AltaRecord {
  id: InvoiceId;
  issuerName: string;
  /** F2 simplified invoice, R5 corrective simplified invoice. */
  invoiceType: 'F2' | 'R5';
  description: string;
  breakdown: BreakdownLine[];
  taxTotalCents: number;
  totalCents: number;
  previous: ChainRef | null;
  system: SystemInfo;
  generatedAt: string; // FechaHoraHusoGenRegistro
  rectified?: InvoiceId[];
}

export interface CancelRecord {
  id: InvoiceId;
  previous: ChainRef | null;
  system: SystemInfo;
  generatedAt: string;
}

export function amount(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg && abs !== 0 ? `-${s}` : s;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** dd-MM-yyyy and ISO timestamp with offset, both as Madrid wall-clock time. */
export function madridParts(date: Date): { day: string; timestamp: string } {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour,
    +p.minute,
    +p.second,
  );
  const offsetMin = Math.round(
    (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000,
  );
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return {
    day: `${p.day}-${p.month}-${p.year}`,
    timestamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  };
}

const clean = (s: string) => s.trim();

export function altaString(a: {
  id: InvoiceId;
  invoiceType: string;
  taxTotalCents: number;
  totalCents: number;
  previousHash: string;
  generatedAt: string;
}): string {
  return (
    `IDEmisorFactura=${clean(a.id.issuerNif)}` +
    `&NumSerieFactura=${clean(a.id.number)}` +
    `&FechaExpedicionFactura=${a.id.issueDate}` +
    `&TipoFactura=${clean(a.invoiceType)}` +
    `&CuotaTotal=${amount(a.taxTotalCents)}` +
    `&ImporteTotal=${amount(a.totalCents)}` +
    `&Huella=${clean(a.previousHash)}` +
    `&FechaHoraHusoGenRegistro=${a.generatedAt}`
  );
}

export function cancelString(c: {
  id: InvoiceId;
  previousHash: string;
  generatedAt: string;
}): string {
  return (
    `IDEmisorFacturaAnulada=${clean(c.id.issuerNif)}` +
    `&NumSerieFacturaAnulada=${clean(c.id.number)}` +
    `&FechaExpedicionFacturaAnulada=${c.id.issueDate}` +
    `&Huella=${clean(c.previousHash)}` +
    `&FechaHoraHusoGenRegistro=${c.generatedAt}`
  );
}

/** SHA-256 of the UTF-8 text as 64 upper-case hex characters. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
}

export function altaHash(r: AltaRecord): string {
  return fingerprint(
    altaString({
      id: r.id,
      invoiceType: r.invoiceType,
      taxTotalCents: r.taxTotalCents,
      totalCents: r.totalCents,
      previousHash: r.previous?.hash ?? '',
      generatedAt: r.generatedAt,
    }),
  );
}

export function cancelHash(r: CancelRecord): string {
  return fingerprint(
    cancelString({
      id: r.id,
      previousHash: r.previous?.hash ?? '',
      generatedAt: r.generatedAt,
    }),
  );
}

export function validateInvoiceNumber(n: string): void {
  const t = clean(n);
  if (!t || t.length > 60)
    throw new Error('verifactu: invoice number must be 1 to 60 characters');
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126)
      throw new Error(
        `verifactu: invoice number "${t}" has a character outside ASCII 32-126`,
      );
  }
}

/** Verification URL printed as a QR code on the invoice (AEAT QR specification v0.5.0). */
export function qrUrl(
  env: VerifactuEnvironment,
  id: InvoiceId,
  totalCents: number,
): string {
  validateInvoiceNumber(id.number);
  const nif = clean(id.issuerNif);
  if (nif.length !== 9)
    throw new Error('verifactu: issuer NIF must be 9 characters');
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  return `${QR_BASE[env]}?nif=${enc(nif)}&numserie=${enc(clean(id.number))}&fecha=${id.issueDate}&importe=${amount(totalCents)}`;
}

function esc(s: string): string {
  return s
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
const el = (name: string, val: string) =>
  `<sf:${name}>${esc(val)}</sf:${name}>`;
const rate2 = (r: number) => r.toFixed(2);

function chainXml(prev: ChainRef | null): string {
  if (!prev)
    return `<sf:Encadenamiento>${el('PrimerRegistro', 'S')}</sf:Encadenamiento>`;
  return (
    '<sf:Encadenamiento><sf:RegistroAnterior>' +
    el('IDEmisorFactura', prev.issuerNif) +
    el('NumSerieFactura', prev.number) +
    el('FechaExpedicionFactura', prev.issueDate) +
    el('Huella', prev.hash) +
    '</sf:RegistroAnterior></sf:Encadenamiento>'
  );
}

function systemXml(s: SystemInfo): string {
  const producerId =
    s.producerCountry.toUpperCase() === 'ES'
      ? el('NIF', s.producerId)
      : '<sf:IDOtro>' +
        el('CodigoPais', s.producerCountry.toUpperCase()) +
        el('IDType', s.producerIdType) +
        el('ID', s.producerId) +
        '</sf:IDOtro>';
  return (
    '<sf:SistemaInformatico>' +
    el('NombreRazon', s.producerName) +
    producerId +
    el('NombreSistemaInformatico', s.systemName) +
    el('IdSistemaInformatico', s.systemId) +
    el('Version', s.version) +
    el('NumeroInstalacion', s.installationNumber) +
    el('TipoUsoPosibleSoloVerifactu', 'S') +
    el('TipoUsoPosibleMultiOT', 'N') +
    el('IndicadorMultiplesOT', 'N') +
    '</sf:SistemaInformatico>'
  );
}

export function altaXml(r: AltaRecord): string {
  let x = '<sf:RegistroAlta>' + el('IDVersion', '1.0');
  x +=
    '<sf:IDFactura>' +
    el('IDEmisorFactura', r.id.issuerNif) +
    el('NumSerieFactura', r.id.number) +
    el('FechaExpedicionFactura', r.id.issueDate) +
    '</sf:IDFactura>';
  x += el('NombreRazonEmisor', r.issuerName) + el('TipoFactura', r.invoiceType);
  if (r.invoiceType === 'R5') {
    x += el('TipoRectificativa', 'I');
    if (r.rectified?.length) {
      x += '<sf:FacturasRectificadas>';
      for (const o of r.rectified) {
        x +=
          '<sf:IDFacturaRectificada>' +
          el('IDEmisorFactura', o.issuerNif) +
          el('NumSerieFactura', o.number) +
          el('FechaExpedicionFactura', o.issueDate) +
          '</sf:IDFacturaRectificada>';
      }
      x += '</sf:FacturasRectificadas>';
    }
  }
  x += el('DescripcionOperacion', r.description);
  x += '<sf:Desglose>';
  for (const b of r.breakdown) {
    x +=
      '<sf:DetalleDesglose>' +
      el('Impuesto', '01') +
      el('ClaveRegimen', '01') +
      el('CalificacionOperacion', 'S1') +
      el('TipoImpositivo', rate2(b.rate)) +
      el('BaseImponibleOimporteNoSujeto', amount(b.baseCents)) +
      el('CuotaRepercutida', amount(b.quotaCents)) +
      '</sf:DetalleDesglose>';
  }
  x += '</sf:Desglose>';
  x +=
    el('CuotaTotal', amount(r.taxTotalCents)) +
    el('ImporteTotal', amount(r.totalCents));
  x += chainXml(r.previous) + systemXml(r.system);
  x +=
    el('FechaHoraHusoGenRegistro', r.generatedAt) +
    el('TipoHuella', '01') +
    el('Huella', altaHash(r));
  return x + '</sf:RegistroAlta>';
}

export function cancelXml(c: CancelRecord): string {
  return (
    '<sf:RegistroAnulacion>' +
    el('IDVersion', '1.0') +
    '<sf:IDFactura>' +
    el('IDEmisorFacturaAnulada', c.id.issuerNif) +
    el('NumSerieFacturaAnulada', c.id.number) +
    el('FechaExpedicionFacturaAnulada', c.id.issueDate) +
    '</sf:IDFactura>' +
    chainXml(c.previous) +
    systemXml(c.system) +
    el('FechaHoraHusoGenRegistro', c.generatedAt) +
    el('TipoHuella', '01') +
    el('Huella', cancelHash(c)) +
    '</sf:RegistroAnulacion>'
  );
}

export function envelope(
  issuerName: string,
  issuerNif: string,
  records: string[],
): string {
  return (
    `<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="${NS_LR}" xmlns:sf="${NS_INFO}">` +
    `<sfLR:Cabecera><sf:ObligadoEmision><sf:NombreRazon>${esc(issuerName)}</sf:NombreRazon><sf:NIF>${esc(issuerNif)}</sf:NIF></sf:ObligadoEmision></sfLR:Cabecera>` +
    records
      .map((r) => `<sfLR:RegistroFactura>${r}</sfLR:RegistroFactura>`)
      .join('') +
    '</sfLR:RegFactuSistemaFacturacion>'
  );
}

export function soap(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>' +
    body +
    '</soapenv:Body></soapenv:Envelope>'
  );
}

export interface GrossLine {
  /** Tax-inclusive amount in cents for this line, before bill-level discounts. */
  grossCents: number;
  ratePercent: number;
}

/**
 * Splits a tax-inclusive sale into one AEAT breakdown line per IVA rate. `targetCents` is what the
 * invoice must total (bill after discounts, delivery fee included, tip excluded); it is shared across
 * the rate groups in proportion to their gross using the largest-remainder method so the pieces add up
 * to the cent. A negative target (refund) yields negative amounts.
 */
export function buildBreakdown(
  lines: GrossLine[],
  targetCents: number,
): {
  breakdown: BreakdownLine[];
  taxTotalCents: number;
  totalCents: number;
} {
  const sign = targetCents < 0 ? -1 : 1;
  const target = Math.abs(targetCents);
  const groups = new Map<number, number>();
  for (const l of lines) {
    if (!(IVA_RATES as readonly number[]).includes(l.ratePercent)) {
      throw new Error(
        `verifactu: ${l.ratePercent}% is not a Spanish IVA rate; fix the item's tax rate (0, 2, 4, 5, 7.5, 10 or 21)`,
      );
    }
    groups.set(l.ratePercent, (groups.get(l.ratePercent) ?? 0) + l.grossCents);
  }
  const sumGross = [...groups.values()].reduce((a, b) => a + b, 0);
  if (sumGross <= 0)
    throw new Error('verifactu: the sale has no taxable lines');
  const entries = [...groups.entries()].sort((a, b) => b[0] - a[0]);
  const shares = entries.map(([rate, gross]) => {
    const exact = (target * gross) / sumGross;
    return { rate, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = target - shares.reduce((a, s) => a + s.floor, 0);
  [...shares]
    .sort((a, b) => b.frac - a.frac)
    .forEach((s) => {
      if (left > 0) {
        s.floor += 1;
        left -= 1;
      }
    });
  const breakdown: BreakdownLine[] = shares.map((s) => {
    const base = Math.round(s.floor / (1 + s.rate / 100));
    return {
      rate: s.rate,
      baseCents: sign * base,
      quotaCents: sign * (s.floor - base),
    };
  });
  const taxTotalCents = breakdown.reduce((a, b) => a + b.quotaCents, 0);
  return { breakdown, taxTotalCents, totalCents: sign * target };
}

export function validateAlta(r: AltaRecord): void {
  validateInvoiceNumber(r.id.number);
  if (r.id.issuerNif.trim().length !== 9) {
    throw new Error(
      "verifactu: the branch's tax ID (NIF/CIF) must be 9 characters; set it in branch settings",
    );
  }
  if (!r.issuerName.trim() || r.issuerName.length > 120) {
    throw new Error(
      'verifactu: the legal name is required and at most 120 characters',
    );
  }
  if (!r.description.trim() || r.description.length > 500)
    throw new Error('verifactu: description is required');
  if (r.breakdown.length === 0 || r.breakdown.length > 12)
    throw new Error('verifactu: 1 to 12 tax breakdown lines');
  const base = r.breakdown.reduce((a, b) => a + b.baseCents, 0);
  const quota = r.breakdown.reduce((a, b) => a + b.quotaCents, 0);
  if (quota !== r.taxTotalCents)
    throw new Error('verifactu: tax total does not match the breakdown');
  if (base + quota !== r.totalCents)
    throw new Error('verifactu: invoice total does not match base plus tax');
}
