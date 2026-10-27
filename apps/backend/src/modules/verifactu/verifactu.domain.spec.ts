import {
  altaHash,
  altaString,
  altaXml,
  amount,
  buildBreakdown,
  cancelHash,
  cancelString,
  cancelXml,
  fingerprint,
  madridParts,
  qrUrl,
  validateAlta,
  validateInvoiceNumber,
  type AltaRecord,
  type SystemInfo,
} from './verifactu.domain';

const sys: SystemInfo = {
  producerName: 'Contrivya',
  producerCountry: 'IN',
  producerIdType: '04',
  producerId: 'U00000AA0000AAA000000',
  systemName: 'OrderlyPOS',
  systemId: 'OR',
  version: '1.0.0',
  installationNumber: 'inst-1',
};

// The three worked examples in AEAT's hash specification v0.1.2, section 6.
describe('AEAT official hash vectors', () => {
  const id1 = {
    issuerNif: '89890001K',
    number: '12345678/G33',
    issueDate: '01-01-2024',
  };
  const id2 = {
    issuerNif: '89890001K',
    number: '12345679/G34',
    issueDate: '01-01-2024',
  };

  it('matches case 1, 2 and the cancellation case 3', () => {
    const first = {
      id: id1,
      invoiceType: 'F1',
      taxTotalCents: 1235,
      totalCents: 12345,
      previousHash: '',
      generatedAt: '2024-01-01T19:20:30+01:00',
    };
    expect(altaString(first)).toBe(
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00',
    );
    const h1 = fingerprint(altaString(first));
    expect(h1).toBe(
      '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
    );
    const h2 = fingerprint(
      altaString({
        ...first,
        id: id2,
        previousHash: h1,
        generatedAt: '2024-01-01T19:20:35+01:00',
      }),
    );
    expect(h2).toBe(
      'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97',
    );
    const c = {
      id: id2,
      previousHash: h2,
      generatedAt: '2024-01-01T19:20:40+01:00',
    };
    expect(cancelString(c)).toBe(
      'IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00',
    );
    expect(
      cancelHash({ ...c, previous: { ...id2, hash: h2 }, system: sys }),
    ).toBe('177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68');
  });
});

describe('qrUrl', () => {
  it('percent-encodes "&" like the AEAT QR document and uses two decimals', () => {
    const id = {
      issuerNif: '89890001K',
      number: '12345678&G33',
      issueDate: '01-01-2024',
    };
    expect(qrUrl('TEST', id, 24140)).toBe(
      'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40',
    );
    expect(
      qrUrl('PRODUCTION', id, 24140).startsWith(
        'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?',
      ),
    ).toBe(true);
  });
  it('rejects a bad NIF', () => {
    expect(() =>
      qrUrl(
        'TEST',
        { issuerNif: 'X', number: '1', issueDate: '01-01-2024' },
        1,
      ),
    ).toThrow();
  });
});

describe('madridParts', () => {
  it('uses +01:00 in winter and +02:00 in summer, in Madrid wall-clock time', () => {
    expect(madridParts(new Date('2024-01-01T18:20:30Z'))).toEqual({
      day: '01-01-2024',
      timestamp: '2024-01-01T19:20:30+01:00',
    });
    expect(madridParts(new Date('2024-07-01T22:30:00Z'))).toEqual({
      day: '02-07-2024',
      timestamp: '2024-07-02T00:30:00+02:00',
    });
  });
});

describe('amount and invoice number', () => {
  it('formats cents with two decimals and a leading minus', () => {
    expect(amount(5)).toBe('0.05');
    expect(amount(-1250)).toBe('-12.50');
    expect(amount(0)).toBe('0.00');
  });
  it('rejects empty, long and non-ASCII numbers', () => {
    expect(() => validateInvoiceNumber('')).toThrow();
    expect(() => validateInvoiceNumber('é1')).toThrow();
    expect(() => validateInvoiceNumber('x'.repeat(61))).toThrow();
    expect(() => validateInvoiceNumber('T1-000001')).not.toThrow();
  });
});

describe('buildBreakdown', () => {
  it('backs IVA out of inclusive amounts per rate and always adds up to the target', () => {
    const r = buildBreakdown(
      [
        { grossCents: 1100, ratePercent: 10 },
        { grossCents: 1210, ratePercent: 21 },
      ],
      2310,
    );
    expect(r.totalCents).toBe(2310);
    expect(r.breakdown).toEqual([
      { rate: 21, baseCents: 1000, quotaCents: 210 },
      { rate: 10, baseCents: 1000, quotaCents: 100 },
    ]);
    expect(r.taxTotalCents).toBe(310);
  });
  it('shares a discount across rates without losing a cent', () => {
    for (const target of [1999, 2000, 2307, 1]) {
      const r = buildBreakdown(
        [
          { grossCents: 777, ratePercent: 10 },
          { grossCents: 1333, ratePercent: 21 },
          { grossCents: 201, ratePercent: 4 },
        ],
        target,
      );
      const sum = r.breakdown.reduce(
        (a, b) => a + b.baseCents + b.quotaCents,
        0,
      );
      expect(sum).toBe(target);
      expect(r.totalCents).toBe(target);
    }
  });
  it('produces negative amounts for a refund', () => {
    const r = buildBreakdown([{ grossCents: 1100, ratePercent: 10 }], -550);
    expect(r.totalCents).toBe(-550);
    expect(r.breakdown[0]).toEqual({
      rate: 10,
      baseCents: -500,
      quotaCents: -50,
    });
    expect(r.taxTotalCents).toBe(-50);
  });
  it('refuses a non-Spanish rate instead of guessing', () => {
    expect(() =>
      buildBreakdown([{ grossCents: 100, ratePercent: 18 }], 100),
    ).toThrow(/not a Spanish IVA rate/);
  });
});

describe('records', () => {
  const rec = (over: Partial<AltaRecord> = {}): AltaRecord => {
    const b = buildBreakdown([{ grossCents: 1100, ratePercent: 10 }], 1100);
    return {
      id: {
        issuerNif: 'B12345678',
        number: 'T1-000001',
        issueDate: '02-07-2024',
      },
      issuerName: 'Bar & Grill SL',
      invoiceType: 'F2',
      description: 'Servicios de restauración',
      breakdown: b.breakdown,
      taxTotalCents: b.taxTotalCents,
      totalCents: b.totalCents,
      previous: null,
      system: sys,
      generatedAt: '2024-07-02T00:30:00+02:00',
      ...over,
    };
  };
  it('writes a first record with PrimerRegistro and a matching hash, escaping XML', () => {
    const r = rec();
    validateAlta(r);
    const x = altaXml(r);
    expect(x).toContain('<sf:PrimerRegistro>S</sf:PrimerRegistro>');
    expect(x).toContain(
      '<sf:NombreRazonEmisor>Bar &amp; Grill SL</sf:NombreRazonEmisor>',
    );
    expect(x).toContain(`<sf:Huella>${altaHash(r)}</sf:Huella>`);
    expect(x).toContain('<sf:TipoImpositivo>10.00</sf:TipoImpositivo>');
  });
  it('chains the next record on the previous hash', () => {
    const a = rec();
    const b = rec({
      id: { ...a.id, number: 'T1-000002' },
      previous: { ...a.id, hash: altaHash(a) },
    });
    expect(altaXml(b)).toContain(
      `<sf:Huella>${altaHash(a)}</sf:Huella></sf:RegistroAnterior>`,
    );
    expect(altaHash(b)).not.toBe(altaHash(a));
  });
  it('writes a corrective simplified invoice (R5) with the original it rectifies', () => {
    const a = rec();
    const rb = buildBreakdown([{ grossCents: 1100, ratePercent: 10 }], -1100);
    const x = altaXml(
      rec({
        invoiceType: 'R5',
        id: { ...a.id, number: 'R1-000001' },
        breakdown: rb.breakdown,
        taxTotalCents: rb.taxTotalCents,
        totalCents: rb.totalCents,
        rectified: [a.id],
      }),
    );
    expect(x).toContain('<sf:TipoRectificativa>I</sf:TipoRectificativa>');
    expect(x).toContain('<sf:IDFacturaRectificada>');
    expect(x).toContain('<sf:ImporteTotal>-11.00</sf:ImporteTotal>');
  });
  it('rejects a tax ID that is not 9 characters', () => {
    expect(() =>
      validateAlta(
        rec({
          id: { issuerNif: 'B123', number: '1', issueDate: '02-07-2024' },
        }),
      ),
    ).toThrow(/NIF/);
  });
  it('writes a cancellation record', () => {
    const a = rec();
    const x = cancelXml({
      id: a.id,
      previous: { ...a.id, hash: altaHash(a) },
      system: sys,
      generatedAt: '2024-07-02T01:00:00+02:00',
    });
    expect(x).toContain(
      '<sf:IDEmisorFacturaAnulada>B12345678</sf:IDEmisorFacturaAnulada>',
    );
  });
});
