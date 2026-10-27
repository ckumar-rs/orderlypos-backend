import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// RealtimeGateway is provided by the @Global() RealtimeModule (see
// realtime.module.ts) and PrismaService by the @Global() PrismaModule, so
// neither needs an explicit import here — same pattern TablesModule/
// OrdersModule already rely on.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
