import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { CommerceModule } from '../commerce/commerce.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { PublicKioskController } from './public-kiosk.controller';
import { PublicKioskService } from './public-kiosk.service';
import { PublicMenuController } from './public-menu.controller';
import { PublicMenuService } from './public-menu.service';
import { PublicPickupController } from './public-pickup.controller';
import { PublicPickupService } from './public-pickup.service';
import { PublicPayController } from './public-pay.controller';
import { PublicPayService } from './public-pay.service';

@Module({
  imports: [OrdersModule, MenuModule, NotificationsModule, CommerceModule],
  controllers: [
    PublicMenuController,
    PublicKioskController,
    PublicPickupController,
    PublicPayController,
  ],
  providers: [
    PublicMenuService,
    PublicKioskService,
    PublicPickupService,
    PublicPayService,
  ],
  exports: [PublicPayService],
})
export class PublicModule {}
