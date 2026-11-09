import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MessagingService } from './messaging.service';

function header(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

type BulkStatusBody = {
  clientMessageId?: string;
  messageId?: string;
  providerRef?: string;
  status?: string;
  error?: string;
};

/**
 * Status callbacks from the linked standalone bulk WhatsApp platform.
 * POST /api/v1/public/bulk-whatsapp/status
 * Header: x-webhook-secret (optional if the restaurant has not set one)
 * Body: { clientMessageId | providerRef | messageId, status, error? }
 */
@ApiTags('messaging-public')
@Controller('v1/public/bulk-whatsapp')
export class MessagingPublicController {
  constructor(private readonly messaging: MessagingService) {}

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('status')
  @HttpCode(200)
  status(
    @Body() body: BulkStatusBody,
    @Headers('x-webhook-secret') webhookSecret: string | string[] | undefined,
  ) {
    const status = typeof body?.status === 'string' ? body.status : '';
    if (!status.trim()) {
      return { ok: false, error: 'status required' };
    }
    return this.messaging.applyBulkStatus({
      clientMessageId: body.clientMessageId?.trim() || null,
      providerRef:
        body.providerRef?.trim() || body.messageId?.trim() || null,
      status,
      error: body.error ?? null,
      secretHeader: header(webhookSecret) ?? null,
    });
  }
}
