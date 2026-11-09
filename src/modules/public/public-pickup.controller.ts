import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicPickupService } from './public-pickup.service';

@ApiTags('public')
@Controller('v1/public/pickup')
export class PublicPickupController {
  constructor(private readonly pickup: PublicPickupService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token')
  getQueue(@Param('token') token: string) {
    return this.pickup.getQueue(token);
  }
}
