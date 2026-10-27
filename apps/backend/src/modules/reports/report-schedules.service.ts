import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { ReportFrequency, ReportSchedule } from '@prisma/client';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { EXPORT_TYPES, isExportFormat, renderReport } from './export';
import { REPORT_CATALOG, ReportsService } from './reports.service';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso_: string, n: number) => {
  const d = new Date(`${iso_}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Previous full period, in the branch's own calendar, for a frequency. */
export function periodFor(frequency: ReportFrequency, today: string) {
  if (frequency === 'DAILY') {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  if (frequency === 'WEEKLY') {
    return { from: addDays(today, -7), to: addDays(today, -1) };
  }
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: iso(first), to: iso(last) };
}

/** Is a schedule due, given the branch-local date and hour? Sends at 06:00. */
export function isDue(
  s: Pick<ReportSchedule, 'frequency' | 'lastSentAt'>,
  localDate: string,
  localHour: number,
  lastSentLocalDate: string | null,
) {
  if (localHour < 6) return false;
  if (lastSentLocalDate === localDate) return false;
  const dow = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const dom = Number(localDate.slice(8, 10));
  if (s.frequency === 'WEEKLY') return dow === 1; // Mondays
  if (s.frequency === 'MONTHLY') return dom === 1;
  return true;
}

@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly email: EmailService,
    private readonly time: BranchTimeService,
  ) {}

  list(branchId: string) {
    return this.prisma.reportSchedule.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    branchId: string,
    dto: {
      reportKey: string;
      frequency: ReportFrequency;
      format: string;
      recipients: string[];
    },
  ) {
    if (!REPORT_CATALOG.some((r) => r.key === dto.reportKey))
      throw new BadRequestException('Unknown report');
    if (!isExportFormat(dto.format))
      throw new BadRequestException('Format must be csv, xlsx or pdf');
    const recipients = [
      ...new Set(dto.recipients.map((r) => r.trim().toLowerCase())),
    ];
    if (!recipients.length || recipients.some((r) => !EMAIL.test(r)))
      throw new BadRequestException('Enter valid recipient email addresses');
    return this.prisma.reportSchedule.create({
      data: { branchId, ...dto, recipients },
    });
  }

  async setActive(branchId: string, id: string, isActive: boolean) {
    await this.get(branchId, id);
    return this.prisma.reportSchedule.update({
      where: { id },
      data: { isActive },
    });
  }

  async remove(branchId: string, id: string) {
    await this.get(branchId, id);
    await this.prisma.reportSchedule.delete({ where: { id } });
    return { ok: true };
  }

  private async get(branchId: string, id: string) {
    const s = await this.prisma.reportSchedule.findFirst({
      where: { id, branchId },
    });
    if (!s) throw new NotFoundException('Schedule not found');
    return s;
  }

  /** Send one schedule now (used by the cron tick and the "Send now" button). */
  async deliver(s: ReportSchedule, today: string) {
    if (!this.email.isConfigured())
      throw new BadRequestException(
        'Email is not set up: set SMTP_URL and SMTP_FROM on the server',
      );
    const { from, to } = periodFor(s.frequency, today);
    const result = await this.reports.run(s.reportKey, s.branchId, from, to);
    const format = isExportFormat(s.format) ? s.format : 'xlsx';
    const body = await renderReport(result, format, `${from} to ${to}`);
    const t = EXPORT_TYPES[format];
    const subject = `${result.title} · ${from === to ? from : `${from} to ${to}`}`;
    const out = await this.email.sendEach(
      s.recipients.map((to_) => ({
        to: to_,
        subject,
        text: `Your scheduled ${result.title} report for ${from} to ${to} is attached.\n\nSent by OrderlyPOS.`,
        attachments: [
          {
            filename: `${s.reportKey}_${from}_${to}.${t.ext}`,
            content: body,
            contentType: t.mime.split(';')[0],
          },
        ],
      })),
    );
    if (!out.sent) throw new BadRequestException('No email could be delivered');
    await this.prisma.reportSchedule.update({
      where: { id: s.id },
      data: {
        lastSentAt: new Date(),
        lastError: out.failed ? `${out.failed} recipient(s) failed` : null,
      },
    });
    return out;
  }

  async sendNow(branchId: string, id: string) {
    const s = await this.get(branchId, id);
    const tz = await this.time.tzForBranch(branchId);
    return this.deliver(s, this.localToday(tz).date);
  }

  private localToday(tz: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    return {
      date: `${g('year')}-${g('month')}-${g('day')}`,
      hour: Number(g('hour')),
    };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick() {
    try {
      if (!this.email.isConfigured()) return;
      const schedules = await this.prisma.reportSchedule.findMany({
        where: { isActive: true },
      });
      for (const s of schedules) {
        const tz = await this.time.tzForBranch(s.branchId);
        const now = this.localToday(tz);
        const lastLocal = s.lastSentAt
          ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
              s.lastSentAt,
            )
          : null;
        if (!isDue(s, now.date, now.hour, lastLocal)) continue;
        try {
          await this.deliver(s, now.date);
          this.logger.log(`Sent scheduled report ${s.reportKey} (${s.id})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Scheduled report ${s.id} failed: ${msg}`);
          await this.prisma.reportSchedule.update({
            where: { id: s.id },
            data: { lastError: msg.slice(0, 300) },
          });
        }
      }
    } catch (err) {
      this.logger.error(
        `Report schedule tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
