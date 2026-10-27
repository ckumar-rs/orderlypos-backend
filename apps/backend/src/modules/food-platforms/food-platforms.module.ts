import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { OrdersModule } from '../orders/orders.module';
import { FoodPlatformIntakeController } from './food-platform-intake.controller';
import { FoodPlatformSettingsController } from './food-platform-settings.controller';
import { FoodPlatformsService } from './food-platforms.service';

@Module({
  imports: [OrdersModule, AuditModule],
  controllers: [FoodPlatformSettingsController, FoodPlatformIntakeController],
  providers: [FoodPlatformsService, BranchAccessService],
})
export class FoodPlatformsModule {}
