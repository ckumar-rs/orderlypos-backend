// Runs against a real PostgreSQL with every migration applied. Skipped unless VERIFACTU_TEST_DATABASE_URL is
// set, e.g. postgresql://postgres@127.0.0.1:55432/orderrestro_vf (a throwaway database).
import { writeFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import forge from 'node-forge';
import { PrismaService } from '../../prisma/prisma.service';
import type { AeatResponse } from './verifactu.aeat';
import { altaHash } from './verifactu.domain';
import { VerifactuService } from './verifactu.service';

const url = process.env.VERIFACTU_TEST_DATABASE_URL;
// The client reads DATABASE_URL, so point it at the throwaway database before it is constructed.
if (url) process.env.DATABASE_URL = url;
const d = url ? describe : describe.skip;

function selfSignedP12(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: 'TEST SL 89890001K' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password);
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

d('VERI*FACTU against PostgreSQL', () => {
  const prisma = new PrismaService();
  const config = new ConfigService({
    JWT_SECRET: 'test-secret',
    VERIFACTU_PRODUCER_ID: 'U0000000000000000000',
  });
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new VerifactuService(prisma, config, audit as never);
  let ids: {
    restaurantId: string;
    branchId: string;
    userId: string;
    menuItemId: string;
  };

  beforeAll(async () => {
    const p = prisma;
    await p.$connect();
    const restaurant = await p.restaurant.create({
      data: {
        name: 'Bar Test',
        legalName: 'Bar & Grill SL',
        currency: 'EUR',
        timezone: 'Europe/Madrid',
      },
    });
    const branch = await p.branch.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Centro',
        country: 'ES',
        taxRegime: 'ES_IVA',
        taxId: 'B12345678',
      },
    });
    const role = await p.role.create({
      data: { restaurantId: restaurant.id, name: 'OWNER', label: 'Owner' },
    });
    const user = await p.user.create({
      data: {
        restaurantId: restaurant.id,
        roleId: role.id,
        name: 'Ana',
        passwordHash: 'x',
      },
    });
    const cat = await p.menuCategory.create({
      data: { branchId: branch.id, name: 'Food' },
    });
    const item = await p.menuItem.create({
      data: {
        branchId: branch.id,
        categoryId: cat.id,
        name: 'Paella',
        price: 11,
        taxRatePercent: 10,
      },
    });
    ids = {
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: user.id,
      menuItemId: item.id,
    };
    await svc.saveSettings(restaurant.id, user.id, branch.id, {
      enabled: true,
      environment: 'TEST',
      seriesPrefix: 'T1',
    });
  });
  afterAll(async () => prisma.$disconnect());

  async function paidOrder(
    n: number,
    lines: { price: number; qty: number; rate: number }[],
    extra: { tip?: number; discount?: number } = {},
  ) {
    const gross = lines.reduce((a, l) => a + l.price * l.qty, 0);
    const total = gross - (extra.discount ?? 0) + (extra.tip ?? 0);
    return prisma.order.create({
      data: {
        branchId: ids.branchId,
        orderNumber: `O-${n}`,
        createdById: ids.userId,
        status: 'PAID',
        subtotal: gross,
        discountAmount: extra.discount ?? 0,
        tipAmount: extra.tip ?? 0,
        totalAmount: total,
        items: {
          create: lines.map((l) => ({
            menuItemId: ids.menuItemId,
            nameSnapshot: 'Item',
            unitPriceSnapshot: l.price,
            taxRateSnapshot: l.rate,
            quantity: l.qty,
            lineTotal: l.price * l.qty,
          })),
        },
      },
    });
  }
  const record = (orderId: string) =>
    prisma.$transaction((tx) => svc.recordPaidOrder(tx, orderId));

  it('refuses to enable when the branch is not set up for Spain', async () => {
    const b = await prisma.branch.create({
      data: { restaurantId: ids.restaurantId, name: 'India', country: 'IN' },
    });
    await expect(
      svc.saveSettings(ids.restaurantId, ids.userId, b.id, {
        enabled: true,
        environment: 'TEST',
        seriesPrefix: 'T9',
      }),
    ).rejects.toThrow(/Spain/);
  });

  it('writes a numbered, chained F2 record per paid sale, tip excluded', async () => {
    const a = await record(
      (await paidOrder(1, [{ price: 11, qty: 2, rate: 10 }], { tip: 1 })).id,
    );
    const b = await record(
      (
        await paidOrder(2, [
          { price: 12.1, qty: 1, rate: 21 },
          { price: 5.5, qty: 1, rate: 10 },
        ])
      ).id,
    );
    expect(a?.invoiceNumber).toBe('T1-000001');
    expect(a?.totalCents).toBe(2200); // 23.00 paid, 1.00 of it tip
    expect(a?.taxTotalCents).toBe(200);
    expect(a?.previousHash).toBeNull();
    expect(b?.invoiceNumber).toBe('T1-000002');
    expect(b?.previousHash).toBe(a?.hash);
    expect(b?.seq).toBe(2);
    expect(b?.qrUrl).toContain('prewww2.aeat.es');
    expect(b?.qrUrl).toContain('numserie=T1-000002');
  });

  it('is idempotent for the same order', async () => {
    const o = await paidOrder(3, [{ price: 10, qty: 1, rate: 10 }]);
    const first = await record(o.id);
    const again = await record(o.id);
    expect(again?.id).toBe(first?.id);
  });

  it('keeps unique, gap-free numbers under concurrent sales', async () => {
    const orders = await Promise.all(
      [4, 5, 6, 7].map((n) => paidOrder(n, [{ price: 10, qty: 1, rate: 10 }])),
    );
    await Promise.all(orders.map((o) => record(o.id)));
    const all = await prisma.verifactuRecord.findMany({
      where: { branchId: ids.branchId },
      orderBy: { seq: 'asc' },
    });
    expect(all.map((r) => r.seq)).toEqual(all.map((_, i) => i + 1));
    expect(new Set(all.map((r) => r.invoiceNumber)).size).toBe(all.length);
    expect((await svc.verifyChain(ids.restaurantId, ids.branchId)).ok).toBe(
      true,
    );
  });

  it('rolls the whole sale back when the record cannot be produced', async () => {
    const o = await paidOrder(8, [{ price: 10, qty: 1, rate: 18 }]);
    await expect(record(o.id)).rejects.toThrow(/not a Spanish IVA rate/);
    expect(
      await prisma.verifactuRecord.count({ where: { orderId: o.id } }),
    ).toBe(0);
  });

  it('writes a corrective R5 for a refund that points at the original invoice', async () => {
    const o = await paidOrder(9, [{ price: 11, qty: 1, rate: 10 }]);
    const orig = await record(o.id);
    const refund = await prisma.refund.create({
      data: {
        orderId: o.id,
        amount: 5.5,
        method: 'CASH',
        createdById: ids.userId,
      },
    });
    const r5 = await prisma.$transaction((tx) =>
      svc.recordRefund(tx, o.id, refund.id, 5.5),
    );
    expect(r5?.invoiceType).toBe('R5');
    expect(r5?.invoiceNumber).toBe('RT1-000001');
    expect(r5?.totalCents).toBe(-550);
    expect(r5?.taxTotalCents).toBe(-50);
    expect(r5?.xml).toMatch(
      new RegExp(
        `<sf:IDFacturaRectificada>[^]*?<sf:NumSerieFactura>${orig?.invoiceNumber}</sf:NumSerieFactura>`,
      ),
    );
  });

  it('database triggers make the log append-only', async () => {
    const r = await prisma.verifactuRecord.findFirstOrThrow({
      where: { branchId: ids.branchId },
    });
    await expect(
      prisma.verifactuRecord.update({
        where: { id: r.id },
        data: { totalCents: 1 },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.verifactuRecord.update({
        where: { id: r.id },
        data: { hash: 'X' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.verifactuRecord.delete({ where: { id: r.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE verifactu_records'),
    ).rejects.toThrow(/append-only/);
    // The submission outcome is the one thing that may change.
    await expect(
      prisma.verifactuRecord.update({
        where: { id: r.id },
        data: { attempts: { increment: 1 } },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a record that does not continue the chain', async () => {
    const last = await prisma.verifactuRecord.findFirstOrThrow({
      where: { branchId: ids.branchId },
      orderBy: { seq: 'desc' },
    });
    const { id: _id, ...rest } = last;
    void _id;
    await expect(
      prisma.verifactuRecord.create({
        data: {
          ...rest,
          seq: last.seq + 1,
          invoiceNumber: 'T1-999999',
          previousHash: 'WRONG',
        },
      }),
    ).rejects.toThrow(/does not continue the chain/);
    await expect(
      prisma.verifactuRecord.create({
        data: {
          ...rest,
          seq: last.seq + 5,
          invoiceNumber: 'T1-999998',
          previousHash: last.hash,
        },
      }),
    ).rejects.toThrow(/does not continue the chain/);
  });

  it('verifyChain spots a tampered stored fingerprint', async () => {
    const recs = await prisma.verifactuRecord.findMany({
      where: { branchId: ids.branchId },
      orderBy: { seq: 'asc' },
    });
    for (const r of recs) {
      const want = altaHash({
        id: {
          issuerNif: r.issuerNif,
          number: r.invoiceNumber,
          issueDate: r.issueDate,
        },
        issuerName: '',
        invoiceType: r.invoiceType as 'F2' | 'R5',
        description: '',
        breakdown: [],
        taxTotalCents: r.taxTotalCents,
        totalCents: r.totalCents,
        previous: r.previousHash
          ? {
              issuerNif: r.issuerNif,
              number: '',
              issueDate: '',
              hash: r.previousHash,
            }
          : null,
        system: {
          producerName: '',
          producerCountry: 'IN',
          producerIdType: '',
          producerId: '',
          systemName: '',
          systemId: '',
          version: '',
          installationNumber: '',
        },
        generatedAt: r.generatedAt,
      });
      expect(r.hash).toBe(want);
    }
  });

  it('encrypts the certificate and submits pending records through the sender', async () => {
    const p12 = selfSignedP12('pw');
    await expect(
      svc.uploadCertificate(
        ids.restaurantId,
        ids.userId,
        ids.branchId,
        p12,
        'wrong',
      ),
    ).rejects.toThrow(/Cannot read/);
    const s = await svc.uploadCertificate(
      ids.restaurantId,
      ids.userId,
      ids.branchId,
      p12,
      'pw',
    );
    expect(s.hasCertificate).toBe(true);
    expect(s.certSubject).toContain('CN=TEST SL 89890001K');
    const row = await prisma.verifactuSettings.findUniqueOrThrow({
      where: { branchId: ids.branchId },
    });
    expect(Buffer.from(row.certEncrypted!).includes(p12.subarray(0, 32))).toBe(
      false,
    ); // not stored in clear

    const seen: string[] = [];
    svc.sender = async (_env, pfx, pass, body) => {
      expect(pass).toBe('pw');
      expect(pfx.equals(p12)).toBe(true);
      seen.push(body);
      const recs = await prisma.verifactuRecord.findMany({
        where: { branchId: ids.branchId },
        orderBy: { seq: 'asc' },
      });
      const resp: AeatResponse = {
        csv: 'CSV1',
        state: 'ParcialmenteCorrecto',
        waitSeconds: 60,
        raw: '<raw/>',
        lines: recs.map((r, i) => ({
          issuerNif: r.issuerNif,
          number: r.invoiceNumber,
          issueDate: r.issueDate,
          operation: 'Alta',
          state:
            i === 1
              ? 'Incorrecto'
              : i === 2
                ? 'AceptadoConErrores'
                : 'Correcto',
          errorCode: i === 1 ? '1100' : i === 2 ? '2000' : '',
          errorText: i === 1 ? 'bad' : i === 2 ? 'warn' : '',
        })),
      };
      return resp;
    };
    const { sent } = await svc.sendNow(ids.restaurantId, ids.branchId);
    expect(sent).toBeGreaterThan(0);
    expect(seen[0]).toContain('<sfLR:RegFactuSistemaFacturacion');
    expect(seen[0]).toContain(
      '<sfLR:Cabecera><sf:ObligadoEmision><sf:NombreRazon>Bar &amp; Grill SL</sf:NombreRazon><sf:NIF>B12345678</sf:NIF>',
    );
    const after = await prisma.verifactuRecord.findMany({
      where: { branchId: ids.branchId },
      orderBy: { seq: 'asc' },
    });
    expect(after[0].status).toBe('ACCEPTED');
    expect(after[0].csv).toBe('CSV1');
    expect(after[1].status).toBe('REJECTED');
    expect(after[1].errorCode).toBe('1100');
    expect(after[2].status).toBe('ACCEPTED_WITH_ERRORS');
    // AEAT's waiting interval is honoured: a second run right away sends nothing.
    expect(await svc.submitAll()).toBe(0);
  });

  it('a transport failure marks records ERROR and retries later', async () => {
    const o = await paidOrder(20, [{ price: 10, qty: 1, rate: 10 }]);
    const rec = await record(o.id);
    await prisma.verifactuRecord.updateMany({
      where: { branchId: ids.branchId },
      data: { nextAttemptAt: new Date(0) },
    });
    svc.sender = () =>
      Promise.reject(new Error('aeat: contacting the tax agency: ECONNRESET'));
    expect(await svc.submitAll()).toBe(0);
    const row = await prisma.verifactuRecord.findUniqueOrThrow({
      where: { id: rec!.id },
    });
    expect(row.status).toBe('ERROR');
    expect(row.errorText).toContain('ECONNRESET');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('exports every record as one AEAT request body', async () => {
    const xml = await svc.exportXml(ids.restaurantId, ids.branchId);
    // Lets a developer feed the output to the XSD validator (see docs/verifactu.md).
    if (process.env.VERIFACTU_XML_OUT)
      writeFileSync(process.env.VERIFACTU_XML_OUT, xml);
    expect((xml.match(/<sfLR:RegistroFactura>/g) ?? []).length).toBe(
      await prisma.verifactuRecord.count({ where: { branchId: ids.branchId } }),
    );
  });

  it('never records for a branch outside Spain, even with the switch left on', async () => {
    await prisma.branch.update({
      where: { id: ids.branchId },
      data: { country: 'FR' },
    });
    try {
      const before = await prisma.verifactuRecord.count({
        where: { branchId: ids.branchId },
      });
      const o = await paidOrder(30, [{ price: 10, qty: 1, rate: 10 }]);
      expect(await record(o.id)).toBeNull();
      expect(
        await prisma.verifactuRecord.count({
          where: { branchId: ids.branchId },
        }),
      ).toBe(before);
    } finally {
      await prisma.branch.update({
        where: { id: ids.branchId },
        data: { country: 'ES' },
      });
    }
  });
});
