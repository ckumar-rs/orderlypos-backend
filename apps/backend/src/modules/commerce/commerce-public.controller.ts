import { Body, Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CommerceService } from './commerce.service';
import { DeliveryService } from '../delivery/delivery.service';
import { Get } from '@nestjs/common';

function header(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

function signature(value: string | undefined) {
  if (!value) return undefined;
  const v1 = /v1=([a-f0-9]+)/i.exec(value);
  return v1?.[1] ?? value;
}

@ApiTags('commerce-public')
@Controller('v1/public')
export class CommercePublicController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly delivery: DeliveryService,
  ) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('payments/:provider')
  @HttpCode(200)
  payments(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-webhook-signature') webhookSignature: string | string[] | undefined,
    @Headers('x-razorpay-signature') razorpaySignature: string | string[] | undefined,
    @Headers('stripe-signature') stripeSignature: string | string[] | undefined,
    @Headers('x-webhook-secret') webhookSecret: string | string[] | undefined,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    return this.commerce.handleGatewayWebhook(
      provider,
      raw,
      body,
      signature(header(webhookSignature) ?? header(razorpaySignature) ?? header(stripeSignature)),
      header(webhookSecret),
    );
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('edc/:provider')
  @HttpCode(200)
  edc(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-webhook-signature') webhookSignature: string | string[] | undefined,
    @Headers('x-webhook-secret') webhookSecret: string | string[] | undefined,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    return this.commerce.handleEdcWebhook(
      provider,
      raw,
      body,
      signature(header(webhookSignature)),
      header(webhookSecret),
    );
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('fleet/:provider')
  @HttpCode(200)
  fleet(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Headers('x-webhook-secret') webhookSecret: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
  ) {
    const bearer = /^Bearer\s+(\S+)/i.exec(header(authorization) ?? '')?.[1];
    return this.commerce.handleFleetWebhook(provider, body, header(webhookSecret) ?? bearer);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('track/:token')
  track(@Param('token') token: string) {
    return this.delivery.publicTrack(token);
  }
}
