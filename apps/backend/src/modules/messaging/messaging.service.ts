import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { OutboundChannel, OutboundPurpose } from '@prisma/client';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import {
  normalizeMsisdn,
  whatsappMessagesUrl,
  whatsappTemplatePayload,
  whatsappTextPayload,
} from './messaging';

export type DispatchInput = {
  restaurantId: string;
  branchId?: string | null;
  channel: OutboundChannel;
  purpose: OutboundPurpose;
  to: string;
  body: string;
};

type RestaurantMessaging = {
  waCloudEnabled: boolean;
  waCloudBaseUrl: string | null;
  waCloudPhoneNumberId: string | null;
  waCloudAccessTokenSealed: string | null;
  waCloudTemplateName: string | null;
  waCloudTemplateLang: string | null;
  smsEnabled: boolean;
  smsProvider: string | null;
  smsBaseUrl: string | null;
  smsApiKeySealed: string | null;
  smsApiSecretSealed: string | null;
  smsSenderId: string | null;
  smsCountryPrefix: string | null;
};

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }

  async isChannelReady(restaurantId: string, channel: OutboundChannel) {
    const restaurant = await this.load(restaurantId);
    try {
      this.assertReady(restaurant, channel);
      return true;
    } catch {
      return false;
    }
  }

  async dispatch(input: DispatchInput) {
    const row = await this.prisma.outboundMessage.create({
      data: {
        restaurantId: input.restaurantId,
        branchId: input.branchId ?? null,
        channel: input.channel,
        purpose: input.purpose,
        to: input.to,
        body: input.body,
        status: 'QUEUED',
      },
    });
    return this.flushOne(row.id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async flushQueued() {
    const due = await this.prisma.outboundMessage.findMany({
      where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    for (const row of due) {
      try {
        await this.flushOne(row.id);
      } catch (err) {
        this.logger.warn(
          `Outbound ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async list(restaurantId: string, branchId?: string, take = 40) {
    return this.prisma.outboundMessage.findMany({
      where: { restaurantId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, take)),
    });
  }

  async flushOne(id: string) {
    const row = await this.prisma.outboundMessage.findUnique({ where: { id } });
    if (!row || row.status === 'SENT') return row;
    const restaurant = await this.load(row.restaurantId);
    const attempts = row.attempts + 1;
    try {
      this.assertReady(restaurant, row.channel);
      const sent =
        row.channel === 'WHATSAPP'
          ? await this.sendWhatsApp(restaurant, row.to, row.body)
          : await this.sendSms(restaurant, row.to, row.body);
      return this.prisma.outboundMessage.update({
        where: { id },
        data: {
          status: 'SENT',
          attempts,
          provider: sent.provider,
          providerRef: sent.providerRef,
          error: null,
          sentAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = attempts < 3;
      return this.prisma.outboundMessage.update({
        where: { id },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          attempts,
          error: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000),
        },
      });
    }
  }

  private async load(restaurantId: string): Promise<RestaurantMessaging> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        waCloudEnabled: true,
        waCloudBaseUrl: true,
        waCloudPhoneNumberId: true,
        waCloudAccessTokenSealed: true,
        waCloudTemplateName: true,
        waCloudTemplateLang: true,
        smsEnabled: true,
        smsProvider: true,
        smsBaseUrl: true,
        smsApiKeySealed: true,
        smsApiSecretSealed: true,
        smsSenderId: true,
        smsCountryPrefix: true,
      },
    });
    if (!restaurant) throw new BadRequestException('Restaurant not found');
    return restaurant;
  }

  private assertReady(restaurant: RestaurantMessaging, channel: OutboundChannel) {
    if (channel === 'WHATSAPP') {
      if (!restaurant.waCloudEnabled) {
        throw new BadRequestException('WhatsApp Cloud API is off in Operations');
      }
      if (!restaurant.waCloudBaseUrl?.trim()) {
        throw new BadRequestException('Set the WhatsApp Cloud API URL in Operations');
      }
      if (!restaurant.waCloudPhoneNumberId?.trim()) {
        throw new BadRequestException('Set the WhatsApp phone number id in Operations');
      }
      if (!restaurant.waCloudAccessTokenSealed) {
        throw new BadRequestException('Set the WhatsApp access token in Operations');
      }
      return;
    }
    if (!restaurant.smsEnabled) {
      throw new BadRequestException('SMS sending is off in Operations');
    }
    if (!restaurant.smsProvider?.trim()) {
      throw new BadRequestException('Set the SMS provider in Operations');
    }
    if (!restaurant.smsBaseUrl?.trim()) {
      throw new BadRequestException('Set the SMS API URL in Operations');
    }
    if (!restaurant.smsApiKeySealed) {
      throw new BadRequestException('Set the SMS API key in Operations');
    }
  }

  private destination(restaurant: RestaurantMessaging, phone: string) {
    const to = normalizeMsisdn(phone, restaurant.smsCountryPrefix);
    if (!to) throw new BadRequestException('Enter a valid mobile number');
    if (to.length <= 10 && !restaurant.smsCountryPrefix?.trim()) {
      throw new BadRequestException(
        'Set the country prefix in Operations so the number can be sent',
      );
    }
    return to;
  }

  private async sendWhatsApp(
    restaurant: RestaurantMessaging,
    phone: string,
    body: string,
  ) {
    const to = this.destination(restaurant, phone);
    const token = openSecret(restaurant.waCloudAccessTokenSealed!, this.keyMaterial());
    const url = whatsappMessagesUrl(
      restaurant.waCloudBaseUrl!.trim(),
      restaurant.waCloudPhoneNumberId!.trim(),
    );
    const template = restaurant.waCloudTemplateName?.trim();
    const payload = template
      ? whatsappTemplatePayload(
          to,
          template,
          restaurant.waCloudTemplateLang?.trim() || 'en',
          body,
        )
      : whatsappTextPayload(to, body);
    const json = await this.postJson(url, payload, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    const ref = Array.isArray(json.messages)
      ? String((json.messages[0] as { id?: string } | undefined)?.id ?? '')
      : '';
    return { provider: 'WHATSAPP_CLOUD', providerRef: ref || null };
  }

  private async sendSms(
    restaurant: RestaurantMessaging,
    phone: string,
    body: string,
  ) {
    const to = this.destination(restaurant, phone);
    const provider = restaurant.smsProvider!.trim().toUpperCase();
    const apiKey = openSecret(restaurant.smsApiKeySealed!, this.keyMaterial());
    const apiSecret = restaurant.smsApiSecretSealed
      ? openSecret(restaurant.smsApiSecretSealed, this.keyMaterial())
      : '';
    const url = restaurant.smsBaseUrl!.trim();
    const sender = restaurant.smsSenderId?.trim() ?? '';

    if (provider === 'TWILIO') {
      const form = new URLSearchParams();
      form.set('To', `+${to}`);
      form.set('From', sender);
      form.set('Body', body);
      const json = await this.postForm(url, form, {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
      });
      return {
        provider: 'TWILIO',
        providerRef: typeof json.sid === 'string' ? json.sid : null,
      };
    }

    if (provider === 'MSG91') {
      const json = await this.postJson(
        url,
        {
          sender,
          route: '4',
          country: restaurant.smsCountryPrefix?.replace(/\D/g, '') || undefined,
          sms: [{ message: body, to: [to] }],
        },
        { authkey: apiKey, 'Content-Type': 'application/json' },
      );
      return {
        provider: 'MSG91',
        providerRef: typeof json.message === 'string' ? json.message : null,
      };
    }

    const json = await this.postJson(
      url,
      { to, text: body, sender },
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    );
    return {
      provider: provider || 'CUSTOM',
      providerRef: typeof json.id === 'string' ? json.id : null,
    };
  }

  private async postJson(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return this.readResponse(response);
  }

  private async postForm(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
  ) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const detail =
        typeof json.error === 'object' && json.error && 'message' in json.error
          ? String((json.error as { message?: string }).message)
          : text.slice(0, 300);
      throw new BadRequestException(detail || `Provider returned ${response.status}`);
    }
    return json;
  }
}
