import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { NotificationsModule } from '../../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { ReportsModule } from '../reports/reports.module';
import { NetworkAccessInterceptor } from './network-access.interceptor';
import { PlatformController } from './platform.controller';
import { PlatformGraphqlService } from './platform-graphql.service';
import { PlatformService } from './platform.service';

@Module({
  imports: [OrdersModule, ReportsModule, NotificationsModule],
  controllers: [PlatformController],
  providers: [
    PlatformService,
    PlatformGraphqlService,
    BranchAccessService,
    { provide: APP_INTERCEPTOR, useClass: NetworkAccessInterceptor },
  ],
})
export class PlatformModule {}
