import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

// PrismaService is provided by the @Global() PrismaModule, so it needs no
// explicit import here — same pattern RolesModule/TablesModule already
// rely on. AuditModule and NotificationsModule are imported explicitly
// (not global) to get their exported services.
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
