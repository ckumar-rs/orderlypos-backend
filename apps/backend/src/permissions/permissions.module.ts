import { Module } from '@nestjs/common';
import { PermissionsSyncService } from './permissions-sync.service';

@Module({
  providers: [PermissionsSyncService],
})
export class PermissionsModule {}
