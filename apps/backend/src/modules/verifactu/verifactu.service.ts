// Spain VERI*FACTU for OrderlyPOS: builds the append-only, hash-chained fiscal record for every paid
// sale and every refund inside the same database transaction as the sale, and reports the records to
// AEAT in the background. Implemented, not certified: see docs/verifactu.md for what remains (the
// producer's Declaracion Responsable and a run against AEAT's pre-production portal).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  inspectCertificate,
  sendToAeat,
  type AeatResponse,
  type AeatSender,
} from './verifactu.aeat';
import {
  altaHash,
  altaXml,
  buildBreakdown,
  envelope,
  madridParts,
  qrUrl,
  validateAlta,
  QR_HEADING,
  QR_SHORT,
  QR_VERIFIABLE,
  type AltaRecord,
  type ChainRef,
  type InvoiceId,
  type SystemInfo,
  type VerifactuEnvironment,
} from './verifactu.domain';

type Tx = Prisma.TransactionClient;

const BATCH = 100;
const RETRY_MS = 5 * 60_000;

export interface VerifactuQr {
  url: string;
  heading: string;
  legend: string;
  short: string;
  invoiceNumber: string;
}

@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);
  private sending = false;
  /** Replaced in tests so no certificate or network is needed. */
  sender: AeatSender = sendToAeat;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ---- producer identity (a legal fact only the software producer can supply) ----
  producer() {
    const get = (k: string, d: string) =>
      (this.config.get<string>(k) ?? '').trim() || d;
    return {
      name: get('VERIFACTU_PRODUCER_NAME', 'Contrivya'),
      country: get('VERIFACTU_PRODUCER_COUNTRY', 'IN'),
      idType: get('VERIFACTU_PRODUCER_ID_TYPE', '04'),
      id: get('VERIFACTU_PRODUCER_ID', ''),
      systemId: get('VERIFACTU_SYSTEM_ID', 'OR'),
      version: get('APP_VERSION', '1.0.0'),
    };
  }

  private system(installationNumber: string): SystemInfo {
    const p = this.producer();
    return {
      producerName: p.name,
      producerCountry: p.country,
      producerIdType: p.idType,
      producerId: p.id,
      systemName: 'OrderlyPOS',
      systemId: p.systemId,
      version: p.version,
      installationNumber,
    };
  }

  // ---- certificate encryption (AES-256-GCM, key derived from VERIFACTU_KEY or the app secret) ----
  private get key(): Buffer {
    const material =
      this.config.get<string>('VERIFACTU_KEY') ??
      this.config.getOrThrow<string>('JWT_SECRET');
    return createHash('sha256').update(`verifactu:${material}`).digest();
  }
  private seal(plain: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  private open(blob: Buffer, aad: string): Buffer {
    const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  }

  // ---- settings ----
  private async branchOrThrow(restaurantId: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, restaurantId },
      include: { restaurant: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  /** Why this branch cannot issue VERI*FACTU records yet, in plain words. */
  private problems(
    branch: Awaited<ReturnType<VerifactuService['branchOrThrow']>>,
  ): string[] {
    const out: string[] = [];
    if (branch.country !== 'ES')
      out.push('Set the branch country to Spain (ES).');
    if (branch.taxRegime !== 'ES_IVA')
      out.push('Set the branch tax regime to Spain - IVA.');
    if ((branch.taxId ?? '').trim().length !== 9)
      out.push(
        'Enter the branch NIF/CIF (9 characters) in branch tax settings.',
      );
    if (branch.restaurant.currency !== 'EUR')
      out.push('Set the restaurant currency to EUR.');
    if (!(branch.restaurant.legalName ?? branch.restaurant.name).trim())
      out.push('Set the restaurant legal name.');
    const p = this.producer();
    if (!p.id || p.id.length > 20 || p.systemId.length !== 2) {
      out.push(
        'The server operator must set VERIFACTU_PRODUCER_ID (the producer identifier, at most 20 characters) and a 2-character VERIFACTU_SYSTEM_ID.',
      );
    }
    return out;
  }

  async getSettings(restaurantId: string, branchId: string) {
    const branch = await this.branchOrThrow(restaurantId, branchId);
    const s = await this.prisma.verifactuSettings.findUnique({
      where: { branchId },
    });
    const grouped = await this.prisma.verifactuRecord.groupBy({
      by: ['status'],
      where: { branchId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      grouped.map((g) => [g.status, g._count._all]),
    );
    return {
      enabled: s?.enabled ?? false,
      environment: s?.environment ?? 'TEST',
      seriesPrefix: s?.seriesPrefix ?? 'T1',
      nextNumber: s?.nextNumber ?? 1,
      hasCertificate: !!s?.certEncrypted,
      certSubject: s?.certSubject ?? null,
      certExpiresAt: s?.certExpiresAt ?? null,
      problems: this.problems(branch),
      counts,
      status: 'implemented-not-certified',
    };
  }

  async saveSettings(
    restaurantId: string,
    userId: string,
    branchId: string,
    dto: {
      enabled: boolean;
      environment: VerifactuEnvironment;
      seriesPrefix: string;
    },
  ) {
    const branch = await this.branchOrThrow(restaurantId, branchId);
    const prefix = dto.seriesPrefix.trim();
    if (!/^[A-Za-z0-9-]{1,12}$/.test(prefix)) {
      throw new BadRequestException(
        'The invoice series may use letters, digits and "-" (at most 12 characters).',
      );
    }
    if (dto.enabled) {
      const problems = this.problems(branch);
      if (problems.length) throw new BadRequestException(problems.join(' '));
    }
    const existing = await this.prisma.verifactuSettings.findUnique({
      where: { branchId },
    });
    if (existing && existing.seriesPrefix !== prefix) {
      const used = await this.prisma.verifactuRecord.count({
        where: { branchId },
      });
      if (used > 0)
        throw new ConflictException(
          'The series cannot change once records exist; it would restart the numbering.',
        );
    }
    // Two branches of the same company share one chain per environment, so their series must differ.
    const clash = await this.prisma.verifactuSettings.findFirst({
      where: {
        seriesPrefix: prefix,
        branchId: { not: branchId },
        branch: { restaurantId, taxId: branch.taxId },
      },
    });
    if (clash)
      throw new ConflictException(
        `Another branch with the same tax ID already uses the series "${prefix}".`,
      );
    const data = {
      enabled: dto.enabled,
      environment: dto.environment,
      seriesPrefix: prefix,
    };
    const saved = existing
      ? await this.prisma.verifactuSettings.update({
          where: { branchId },
          data,
        })
      : await this.prisma.verifactuSettings.create({
          data: { branchId, installationNumber: randomUUID(), ...data },
        });
    await this.audit.record({
      userId,
      action: 'verifactu.settings_changed',
      entity: 'Branch',
      entityId: branchId,
      metadata: {
        enabled: saved.enabled,
        environment: saved.environment,
        seriesPrefix: saved.seriesPrefix,
      },
    });
    return this.getSettings(restaurantId, branchId);
  }

  async uploadCertificate(
    restaurantId: string,
    userId: string,
    branchId: string,
    file: Buffer,
    password: string,
  ) {
    await this.branchOrThrow(restaurantId, branchId);
    if (!password)
      throw new BadRequestException('Enter the certificate password.');
    let info: { subject: string; expiresAt: Date };
    try {
      info = inspectCertificate(file, password);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    if (info.expiresAt.getTime() < Date.now())
      throw new BadRequestException('This certificate has expired.');
    const existing = await this.prisma.verifactuSettings.findUnique({
      where: { branchId },
    });
    const data = {
      certEncrypted: new Uint8Array(this.seal(file, branchId)),
      certPasswordEncrypted: new Uint8Array(
        this.seal(Buffer.from(password, 'utf8'), branchId),
      ),
      certSubject: info.subject.slice(0, 300),
      certExpiresAt: info.expiresAt,
    };
    if (existing)
      await this.prisma.verifactuSettings.update({ where: { branchId }, data });
    else
      await this.prisma.verifactuSettings.create({
        data: { branchId, installationNumber: randomUUID(), ...data },
      });
    await this.audit.record({
      userId,
      action: 'verifactu.certificate_uploaded',
      entity: 'Branch',
      entityId: branchId,
      metadata: {
        subject: info.subject.slice(0, 300),
        expiresAt: info.expiresAt.toISOString(),
      },
    });
    return this.getSettings(restaurantId, branchId);
  }

  // ---- record creation (called inside the checkout / refund transaction) ----
  private async lockChain(
    tx: Tx,
    restaurantId: string,
    nif: string,
    env: string,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu|${restaurantId}|${nif}|${env}`}))`;
  }

  private async append(
    tx: Tx,
    args: {
      restaurantId: string;
      branchId: string;
      issuerNif: string;
      issuerName: string;
      environment: VerifactuEnvironment;
      installationNumber: string;
      invoiceType: 'F2' | 'R5';
      number: string;
      description: string;
      lines: { grossCents: number; ratePercent: number }[];
      targetCents: number;
      orderId: string;
      refundId?: string;
      rectified?: InvoiceId[];
      now: Date;
    },
  ) {
    const { day, timestamp } = madridParts(args.now);
    await this.lockChain(
      tx,
      args.restaurantId,
      args.issuerNif,
      args.environment,
    );
    const last = await tx.verifactuRecord.findFirst({
      where: {
        restaurantId: args.restaurantId,
        issuerNif: args.issuerNif,
        environment: args.environment,
      },
      orderBy: { seq: 'desc' },
    });
    const previous: ChainRef | null = last
      ? {
          issuerNif: last.issuerNif,
          number: last.invoiceNumber,
          issueDate: last.issueDate,
          hash: last.hash,
        }
      : null;
    const b = buildBreakdown(args.lines, args.targetCents);
    const id: InvoiceId = {
      issuerNif: args.issuerNif,
      number: args.number,
      issueDate: day,
    };
    const rec: AltaRecord = {
      id,
      issuerName: args.issuerName,
      invoiceType: args.invoiceType,
      description: args.description,
      breakdown: b.breakdown,
      taxTotalCents: b.taxTotalCents,
      totalCents: b.totalCents,
      previous,
      system: this.system(args.installationNumber),
      generatedAt: timestamp,
      rectified: args.rectified,
    };
    try {
      validateAlta(rec);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const hash = altaHash(rec);
    return tx.verifactuRecord.create({
      data: {
        restaurantId: args.restaurantId,
        branchId: args.branchId,
        issuerNif: args.issuerNif,
        seq: (last?.seq ?? 0) + 1,
        type: 'ALTA',
        invoiceType: args.invoiceType,
        invoiceNumber: args.number,
        issueDate: day,
        taxTotalCents: b.taxTotalCents,
        totalCents: b.totalCents,
        generatedAt: timestamp,
        previousHash: previous?.hash ?? null,
        hash,
        xml: altaXml(rec),
        qrUrl: qrUrl(args.environment, id, b.totalCents),
        environment: args.environment,
        orderId: args.orderId,
        refundId: args.refundId ?? null,
      },
    });
  }

  private toCents(v: Prisma.Decimal | number): number {
    return Math.round(Number(v) * 100);
  }

  /**
   * Records a fully paid sale as a simplified invoice (F2). A no-op when VERI*FACTU is off for the branch.
   * Throws (rolling the sale back) when the record cannot be produced, because a sale cannot be issued
   * without its fiscal record.
   */
  async recordPaidOrder(tx: Tx, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        branch: { include: { restaurant: true, verifactuSettings: true } },
      },
    });
    const s = order.branch.verifactuSettings;
    // Spain only: a branch outside Spain never records, even if the switch was left on.
    if (!s?.enabled || order.branch.country !== 'ES') return null;
    const problems = this.problems(order.branch);
    if (problems.length)
      throw new BadRequestException(
        `VERI*FACTU is on but not ready: ${problems.join(' ')}`,
      );
    const dup = await tx.verifactuRecord.findFirst({
      where: { orderId, type: 'ALTA', invoiceType: 'F2' },
    });
    if (dup) return dup;
    const bumped = await tx.verifactuSettings.update({
      where: { branchId: s.branchId },
      data: { nextNumber: { increment: 1 } },
    });
    const number = `${s.seriesPrefix}-${String(bumped.nextNumber - 1).padStart(6, '0')}`;
    // Tips are voluntary and outside the taxable operation; everything else the guest paid is invoiced.
    const target =
      this.toCents(order.totalAmount) - this.toCents(order.tipAmount);
    return this.append(tx, {
      restaurantId: order.branch.restaurantId,
      branchId: order.branchId,
      issuerNif: (order.branch.taxId ?? '').trim().toUpperCase(),
      issuerName: (
        order.branch.restaurant.legalName ?? order.branch.restaurant.name
      ).trim(),
      environment: s.environment,
      installationNumber: s.installationNumber,
      invoiceType: 'F2',
      number,
      description: 'Servicios de restauración',
      lines: order.items.map((i) => ({
        grossCents: this.toCents(i.lineTotal),
        ratePercent: Number(i.taxRateSnapshot),
      })),
      targetCents: target,
      orderId,
      now: new Date(),
    });
  }

  /** Records a refund as a corrective simplified invoice (R5, by difference) of the original sale. */
  async recordRefund(
    tx: Tx,
    orderId: string,
    refundId: string,
    amount: Prisma.Decimal | number,
  ) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        branch: { include: { restaurant: true, verifactuSettings: true } },
      },
    });
    const s = order.branch.verifactuSettings;
    if (!s?.enabled || order.branch.country !== 'ES') return null;
    const original = await tx.verifactuRecord.findFirst({
      where: {
        orderId,
        type: 'ALTA',
        invoiceType: 'F2',
        environment: s.environment,
      },
    });
    if (!original) {
      this.logger.warn(
        `Refund ${refundId}: order ${order.orderNumber} was sold before VERI*FACTU was on, so there is no invoice to rectify`,
      );
      return null;
    }
    const bumped = await tx.verifactuSettings.update({
      where: { branchId: s.branchId },
      data: { nextRefundNumber: { increment: 1 } },
    });
    const number = `R${s.seriesPrefix}-${String(bumped.nextRefundNumber - 1).padStart(6, '0')}`;
    return this.append(tx, {
      restaurantId: order.branch.restaurantId,
      branchId: order.branchId,
      issuerNif: original.issuerNif,
      issuerName: (
        order.branch.restaurant.legalName ?? order.branch.restaurant.name
      ).trim(),
      environment: s.environment,
      installationNumber: s.installationNumber,
      invoiceType: 'R5',
      number,
      description: 'Devolución de servicios de restauración',
      lines: order.items.map((i) => ({
        grossCents: this.toCents(i.lineTotal),
        ratePercent: Number(i.taxRateSnapshot),
      })),
      targetCents: -this.toCents(amount),
      orderId,
      refundId,
      rectified: [
        {
          issuerNif: original.issuerNif,
          number: original.invoiceNumber,
          issueDate: original.issueDate,
        },
      ],
      now: new Date(),
    });
  }

  /** True when this paid order already has an invoice, so deleting it would break the fiscal log. */
  async ordersWithRecords(orderIds: string[]): Promise<string[]> {
    const rows = await this.prisma.verifactuRecord.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    return rows.map((r) => r.orderId!).filter(Boolean);
  }

  /** The QR block printed on the customer's receipt, or null when the sale has no VERI*FACTU invoice. */
  async qrForOrder(orderId: string): Promise<VerifactuQr | null> {
    const rec = await this.prisma.verifactuRecord.findFirst({
      where: { orderId, type: 'ALTA', invoiceType: 'F2', qrUrl: { not: null } },
      orderBy: { seq: 'asc' },
    });
    if (!rec?.qrUrl) return null;
    return {
      url: rec.qrUrl,
      heading: QR_HEADING,
      legend: QR_VERIFIABLE,
      short: QR_SHORT,
      invoiceNumber: rec.invoiceNumber,
    };
  }

  // ---- listing, verification, export ----
  async records(restaurantId: string, branchId: string, take = 50, skip = 0) {
    await this.branchOrThrow(restaurantId, branchId);
    const [items, total] = await Promise.all([
      this.prisma.verifactuRecord.findMany({
        where: { branchId },
        orderBy: { seq: 'desc' },
        take: Math.min(Math.max(take, 1), 200),
        skip,
        select: {
          id: true,
          seq: true,
          type: true,
          invoiceType: true,
          invoiceNumber: true,
          issueDate: true,
          totalCents: true,
          taxTotalCents: true,
          hash: true,
          status: true,
          attempts: true,
          csv: true,
          errorCode: true,
          errorText: true,
          submittedAt: true,
          environment: true,
          orderId: true,
        },
      }),
      this.prisma.verifactuRecord.count({ where: { branchId } }),
    ]);
    return { items, total };
  }

  /** Recomputes every hash and link of the branch's chains from the stored fields. */
  async verifyChain(restaurantId: string, branchId: string) {
    const branch = await this.branchOrThrow(restaurantId, branchId);
    const nif = (branch.taxId ?? '').trim().toUpperCase();
    let checked = 0;
    for (const environment of ['TEST', 'PRODUCTION'] as const) {
      const recs = await this.prisma.verifactuRecord.findMany({
        where: { restaurantId, issuerNif: nif, environment },
        orderBy: { seq: 'asc' },
      });
      let prevHash: string | null = null;
      let expectSeq = 1;
      for (const r of recs) {
        checked += 1;
        const fail = (reason: string) => ({
          ok: false as const,
          checked,
          brokenAt: r.seq,
          environment,
          reason,
        });
        if (r.seq !== expectSeq)
          return fail('a record is missing from the sequence');
        if (r.previousHash !== prevHash)
          return fail('the record does not continue the previous one');
        const m =
          /<sf:Huella>([0-9A-F]{64})<\/sf:Huella><\/sf:RegistroAlta>$/.exec(
            r.xml,
          );
        if (!m || m[1] !== r.hash)
          return fail('the stored XML does not match the stored fingerprint');
        const again = this.rehash(r);
        if (again !== r.hash)
          return fail('the fingerprint does not match the record fields');
        prevHash = r.hash;
        expectSeq += 1;
      }
    }
    return { ok: true as const, checked };
  }

  private rehash(r: {
    issuerNif: string;
    invoiceNumber: string;
    issueDate: string;
    invoiceType: string;
    taxTotalCents: number;
    totalCents: number;
    previousHash: string | null;
    generatedAt: string;
  }) {
    return altaHash({
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
      system: this.system(''),
      generatedAt: r.generatedAt,
    });
  }

  async exportXml(restaurantId: string, branchId: string) {
    const branch = await this.branchOrThrow(restaurantId, branchId);
    const recs = await this.prisma.verifactuRecord.findMany({
      where: { branchId },
      orderBy: [{ environment: 'asc' }, { seq: 'asc' }],
    });
    return envelope(
      (branch.restaurant.legalName ?? branch.restaurant.name).trim(),
      (branch.taxId ?? '').trim().toUpperCase(),
      recs.map((r) => r.xml),
    );
  }

  // ---- submission to AEAT ----
  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    try {
      await this.submitAll();
    } catch (e) {
      this.logger.error(
        `VERI*FACTU submission run failed: ${(e as Error).message}`,
      );
    }
  }

  async submitAll(): Promise<number> {
    if (this.sending) return 0;
    this.sending = true;
    try {
      const chains = await this.prisma.verifactuRecord.findMany({
        where: {
          status: { in: ['PENDING', 'ERROR'] },
          nextAttemptAt: { lte: new Date() },
        },
        distinct: ['restaurantId', 'issuerNif', 'environment'],
        select: {
          restaurantId: true,
          issuerNif: true,
          environment: true,
          branchId: true,
        },
      });
      let sent = 0;
      for (const c of chains)
        sent += await this.submitChain(
          c.restaurantId,
          c.issuerNif,
          c.environment,
        );
      return sent;
    } finally {
      this.sending = false;
    }
  }

  async sendNow(restaurantId: string, branchId: string) {
    const branch = await this.branchOrThrow(restaurantId, branchId);
    const nif = (branch.taxId ?? '').trim().toUpperCase();
    await this.prisma.verifactuRecord.updateMany({
      where: {
        restaurantId,
        issuerNif: nif,
        status: { in: ['PENDING', 'ERROR'] },
      },
      data: { nextAttemptAt: new Date() },
    });
    let sent = 0;
    for (const environment of ['TEST', 'PRODUCTION'] as const)
      sent += await this.submitChain(restaurantId, nif, environment);
    return { sent };
  }

  private async submitChain(
    restaurantId: string,
    issuerNif: string,
    environment: VerifactuEnvironment,
  ): Promise<number> {
    const pendingWhere = {
      restaurantId,
      issuerNif,
      environment,
      status: { in: ['PENDING', 'ERROR'] as ('PENDING' | 'ERROR')[] },
    };
    // AEAT asks senders to wait between submissions; every waiting record carries the same release time.
    const waiting = await this.prisma.verifactuRecord.findFirst({
      where: { ...pendingWhere, nextAttemptAt: { gt: new Date() } },
    });
    if (waiting) return 0;
    const recs = await this.prisma.verifactuRecord.findMany({
      where: pendingWhere,
      orderBy: { seq: 'asc' },
      take: BATCH,
    });
    if (recs.length === 0) return 0;
    const branch = await this.prisma.branch.findUnique({
      where: { id: recs[0].branchId },
      include: { restaurant: true, verifactuSettings: true },
    });
    const s = branch?.verifactuSettings;
    if (!branch || !s?.enabled || !s.certEncrypted || !s.certPasswordEncrypted)
      return 0; // waits for a certificate
    let pfx: Buffer;
    let pass: string;
    try {
      pfx = this.open(Buffer.from(s.certEncrypted), s.branchId);
      pass = this.open(
        Buffer.from(s.certPasswordEncrypted),
        s.branchId,
      ).toString('utf8');
    } catch {
      this.logger.error(
        'VERI*FACTU certificate cannot be decrypted (was the app secret changed?). Upload it again.',
      );
      return 0;
    }
    const body = envelope(
      (branch.restaurant.legalName ?? branch.restaurant.name).trim(),
      issuerNif,
      recs.map((r) => r.xml),
    );
    const releaseAfter = async (ms: number) =>
      this.prisma.verifactuRecord.updateMany({
        where: pendingWhere,
        data: { nextAttemptAt: new Date(Date.now() + ms) },
      });
    let resp: AeatResponse;
    try {
      resp = await this.sender(environment, pfx, pass, body);
    } catch (e) {
      const text = (e as Error).message.slice(0, 1000);
      await this.prisma.verifactuRecord.updateMany({
        where: { id: { in: recs.map((r) => r.id) } },
        data: { status: 'ERROR', errorText: text, attempts: { increment: 1 } },
      });
      await releaseAfter(RETRY_MS);
      this.logger.warn(`VERI*FACTU submission failed: ${text}`);
      return 0;
    }
    const byKey = new Map(
      resp.lines.map((l) => [`${l.number}|${l.issueDate}|${l.operation}`, l]),
    );
    for (const r of recs) {
      const l = byKey.get(
        `${r.invoiceNumber}|${r.issueDate}|${r.type === 'ALTA' ? 'Alta' : 'Anulacion'}`,
      );
      let status: 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED' | 'ERROR';
      let errorCode: string | null = null;
      let errorText: string | null = null;
      if (!l && resp.state === 'Correcto') status = 'ACCEPTED';
      else if (!l) {
        status = 'ERROR';
        errorText = 'AEAT returned no result for this record';
      } else if (l.state === 'Correcto') status = 'ACCEPTED';
      else if (l.state === 'AceptadoConErrores') {
        status = 'ACCEPTED_WITH_ERRORS';
        errorCode = l.errorCode;
        errorText = l.errorText;
      } else {
        status = 'REJECTED';
        errorCode = l.errorCode;
        errorText = l.errorText;
      }
      await this.prisma.verifactuRecord.update({
        where: { id: r.id },
        data: {
          status,
          errorCode,
          errorText,
          csv: resp.csv || null,
          responseXml: resp.raw,
          submittedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    }
    await releaseAfter(Math.max(resp.waitSeconds, 60) * 1000);
    return recs.length;
  }
}
