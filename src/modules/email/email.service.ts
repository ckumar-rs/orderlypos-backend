import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

type ResendAccount = {
  apiKey: string;
  from: string;
  source: 'restaurant' | 'env';
};

const RESEND_API = 'https://api.resend.com/emails';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }

  /** Instance-level Resend (env). */
  isConfigured(): boolean {
    return !!(
      this.config.get<string>('RESEND_API_KEY')?.trim() &&
      (
        this.config.get<string>('RESEND_FROM')?.trim() ||
        this.config.get<string>('SMTP_FROM')?.trim()
      )
    );
  }

  async isConfiguredFor(restaurantId: string): Promise<boolean> {
    return !!(await this.account(restaurantId));
  }

  private envAccount(): ResendAccount | null {
    const apiKey = this.config.get<string>('RESEND_API_KEY')?.trim();
    const from =
      this.config.get<string>('RESEND_FROM')?.trim() ||
      this.config.get<string>('SMTP_FROM')?.trim();
    if (!apiKey || !from) return null;
    return { apiKey, from, source: 'env' };
  }

  private async account(restaurantId?: string): Promise<ResendAccount | null> {
    if (restaurantId) {
      const row = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          smtpPasswordSealed: true,
          smtpFrom: true,
        },
      });
      if (row?.smtpPasswordSealed && row.smtpFrom) {
        return {
          apiKey: openSecret(row.smtpPasswordSealed, this.keyMaterial()),
          from: row.smtpFrom,
          source: 'restaurant',
        };
      }
    }
    return this.envAccount();
  }

  private async sendViaResend(
    account: ResendAccount,
    mail: OutgoingEmail,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      from: account.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    };
    if (mail.html) body.html = mail.html;
    if (mail.attachments?.length) {
      body.attachments = mail.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        ...(a.contentType ? { content_type: a.contentType } : {}),
      }));
    }

    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const json = (await res.json()) as { message?: string; name?: string };
        if (json.message) detail = json.message;
      } catch {
        /* ignore */
      }
      throw new Error(`Resend failed: ${detail}`);
    }
  }

  async send(mail: OutgoingEmail, restaurantId?: string): Promise<void> {
    const account = await this.account(restaurantId);
    if (!account) {
      throw new Error(
        'Email is not set up. Add your Resend API key under Settings → Payments, mail, and Tally, or set RESEND_API_KEY and RESEND_FROM on the server.',
      );
    }
    await this.sendViaResend(account, mail);
    this.logger.log(`Sent mail via Resend (${account.source}) to ${mail.to}`);
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

  /** Owner/admin smoke test from Settings. */
  async sendTest(to: string, restaurantId: string) {
    const account = await this.account(restaurantId);
    if (!account) {
      throw new Error(
        'Email is not set up. Save a Resend API key and from address, then try again.',
      );
    }
    await this.send(
      {
        to,
        subject: 'OrderlyPOS test email',
        text: [
          'This is a test message from OrderlyPOS via Resend.',
          `From: ${account.from}`,
          '',
          'If you received this, password resets and receipts can use the same setup.',
        ].join('\n'),
      },
      restaurantId,
    );
    return { ok: true as const, provider: 'resend' as const, from: account.from };
  }
}
