import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  createIntegrationOrderSchema,
  createIntegrationReservationSchema,
} from '@nodedr-restaurant/types';
import { CurrentIntegrationKey } from '../common/decorators/current-integration-key.decorator';
import { RequireScope } from '../common/decorators/require-scope.decorator';
import { IntegrationApiKeyGuard } from '../common/guards/integration-api-key.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { IntegrationKeyContext } from './integrations.service';
import { IntegrationsService } from './integrations.service';

// The public REST API an external website's own backend calls as a
// back end for OrderRestro — list locations, browse a location's menu,
// place an order, book a table, check status. Authenticated by
// Authorization: Bearer <integration api key>, never cookies — see
// docs/integrations-api.md for the full reference and IntegrationApiKeyGuard
// for the auth/scope model. Deliberately NOT behind CORS-any-origin: this
// is meant for server-to-server calls (the partner site's own backend),
// not embedding the raw key in browser JS.
@ApiTags('integrations')
@UseGuards(IntegrationApiKeyGuard)
@Controller('v1/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @RequireScope('locations:read')
  @Get('locations')
  listLocations(@CurrentIntegrationKey() key: IntegrationKeyContext) {
    return this.integrations.listLocations(key);
  }

  @RequireScope('menu:read')
  @Get('locations/:branchId/menu')
  getMenu(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
  ) {
    return this.integrations.getMenu(key, branchId);
  }

  @RequireScope('menu:read')
  @Get('locations/:branchId/delivery-quote')
  deliveryQuote(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
    @Query('pincode') pincode: string,
  ) {
    return this.integrations.deliveryQuote(key, branchId, pincode ?? '');
  }

  @RequireScope('orders:write')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('locations/:branchId/orders')
  @UsePipes(new ZodValidationPipe(createIntegrationOrderSchema))
  createOrder(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    return this.integrations.createOrder(key, branchId, body as never);
  }

  @RequireScope('orders:read')
  @Get('locations/:branchId/orders/:orderId')
  getOrder(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.integrations.getOrder(key, branchId, orderId);
  }

  @RequireScope('reservations:write')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('locations/:branchId/reservations')
  @UsePipes(new ZodValidationPipe(createIntegrationReservationSchema))
  createReservation(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    return this.integrations.createReservation(key, branchId, body as never);
  }

  @RequireScope('reservations:read')
  @Get('locations/:branchId/reservations/:reservationId')
  getReservation(
    @CurrentIntegrationKey() key: IntegrationKeyContext,
    @Param('branchId') branchId: string,
    @Param('reservationId') reservationId: string,
  ) {
    return this.integrations.getReservation(key, branchId, reservationId);
  }
}
