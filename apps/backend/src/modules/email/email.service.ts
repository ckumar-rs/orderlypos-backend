import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

type CachedAccount = {
  from: string;
  transport: Transporter;
  fingerprint: string;
};

@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private readonly accounts = new Map<string, CachedAccount>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleDestroy() {
    for (const account of this.accounts.values()) {
      account.transport.close();
    }
    this.accounts.clear();
  }

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }

  isConfigured(): boolean {
    return !!this.config.get<string>('SMTP_URL') && !!this.config.get<string>('SMTP_FROM');
  }

  async isConfiguredFor(restaurantId: string): Promise<boolean> {
    return !!(await this.account(restaurantId));
  }

  private cached(key: string, fingerprint: string): CachedAccount | null {
    const existing = this.accounts.get(key);
    return existing?.fingerprint === fingerprint ? existing : null;
  }

  private remember(key: string, next: CachedAccount): CachedAccount {
    const existing = this.accounts.get(key);
    if (existing && existing !== next) existing.transport.close();
    this.accounts.set(key, next);
    return next;
  }

  private async account(restaurantId?: string) {
    if (restaurantId) {
      const row = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          smtpHost: true,
          smtpPort: true,
          smtpUser: true,
          smtpPasswordSealed: true,
          smtpFrom: true,
          smtpSecure: true,
        },
      });
      if (row?.smtpHost && row.smtpFrom && row.smtpPasswordSealed) {
        const port = row.smtpPort || (row.smtpSecure ? 465 : 587);
        const fingerprint = [
          row.smtpHost,
          port,
          row.smtpUser,
          row.smtpFrom,
          row.smtpSecure,
          row.smtpPasswordSealed,
        ].join('\0');
        const hit = this.cached(restaurantId, fingerprint);
        if (hit) return hit;
        return this.remember(restaurantId, {
          from: row.smtpFrom,
          fingerprint,
          transport: createTransport({
            pool: true,
            host: row.smtpHost,
            port,
            secure: row.smtpSecure,
            auth: {
              user: row.smtpUser || row.smtpFrom,
              pass: openSecret(row.smtpPasswordSealed, this.keyMaterial()),
            },
          }),
        });
      }
    }
    const url = this.config.get<string>('SMTP_URL');
    const from = this.config.get<string>('SMTP_FROM');
    if (url && from) {
      const fingerprint = `${url}\0${from}`;
      const hit = this.cached('env', fingerprint);
      if (hit) return hit;
      return this.remember('env', {
        from,
        fingerprint,
        transport: createTransport({ pool: true, url }),
      });
    }
    return null;
  }

  async send(mail: OutgoingEmail, restaurantId?: string): Promise<void> {
    const account = await this.account(restaurantId);
    if (!account) {
      throw new Error('Email is not set up. Save the mail server in Settings.');
    }
    await account.transport.sendMail({ from: account.from, ...mail });
  }

  async sendEach(
    mails: OutgoingEmail[],
    restaurantId?: string,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const mail of mails) {
      try {
        await this.send(mail, restaurantId);
        sent++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Email to ${mail.to} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { sent, failed };
  }
}
