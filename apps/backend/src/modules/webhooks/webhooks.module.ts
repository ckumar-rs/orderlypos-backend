import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

// Global so order / reservation / delivery code can emit events without
// importing this module (and without circular imports).
@Global()
@Module({
  imports: [AuditModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
