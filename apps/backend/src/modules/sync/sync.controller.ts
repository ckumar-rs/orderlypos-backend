import { Body, Controller, Get, Headers, Post, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  syncIngestSchema,
  type SessionUser,
  type SyncIngestDto,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Auth()
  @Get('badge')
  badge(@CurrentUser() user: SessionUser) {
    return this.sync.badge(user.restaurantId);
  }

  @Auth('accounting.manage')
  @Get('status')
  status(@CurrentUser() user: SessionUser) {
    return this.sync.status(user.restaurantId);
  }

  @Auth('accounting.manage')
  @Get('events')
  events(@CurrentUser() user: SessionUser) {
    return this.sync.listHqEvents(user.restaurantId);
  }

  @Auth('accounting.manage')
  @Post('tick')
  tick(@CurrentUser() user: SessionUser) {
    return this.sync.tickRestaurant(user.restaurantId);
  }

  @Post('ingest')
  @UsePipes(new ZodValidationPipe(syncIngestSchema))
  ingest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SyncIngestDto,
  ) {
    const token = authorization?.replace(/^Bearer\s+/i, '').trim();
    return this.sync.ingest(token, body);
  }
}
