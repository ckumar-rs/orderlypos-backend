import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { FoodPlatformsService, parseFoodPlatform } from './food-platforms.service';

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function bearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1];
}

// Public on purpose: the platform relay has no staff session. The per-branch
// secret in the header is the credential, and it also selects the branch.
@ApiTags('food-platforms')
@Controller('v1/public/food-platforms')
export class FoodPlatformIntakeController {
  constructor(private readonly platforms: FoodPlatformsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':platform/orders')
  async intake(
    @Param('platform') platform: string,
    @Headers('x-platform-secret') platformSecret: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const secret =
      headerValue(platformSecret) ?? bearer(headerValue(authorization));
    const result = await this.platforms.intake(platform, secret, body);
    res.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':platform/rider')
  async rider(
    @Param('platform') platform: string,
    @Headers('x-platform-secret') platformSecret: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    const secret =
      headerValue(platformSecret) ?? bearer(headerValue(authorization));
    if (!secret) return { ok: false };
    return this.platforms.rider(parseFoodPlatform(platform), secret, body);
  }
}
