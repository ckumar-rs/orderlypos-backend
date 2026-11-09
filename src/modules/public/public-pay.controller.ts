import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicPayService } from './public-pay.service';

// Unauthenticated guest phone bill + UPI. Reachable only by opaque payToken.
@ApiTags('public')
@Controller('v1/public/pay')
export class PublicPayController {
  constructor(private readonly pay: PublicPayService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token')
  getBill(@Param('token') token: string) {
    return this.pay.getBill(token);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/claim-paid')
  claimPaid(@Param('token') token: string) {
    return this.pay.claimPaid(token);
  }
}
