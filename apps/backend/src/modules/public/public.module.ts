import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { PublicKioskController } from './public-kiosk.controller';
import { PublicKioskService } from './public-kiosk.service';
import { PublicMenuController } from './public-menu.controller';
import { PublicMenuService } from './public-menu.service';

@Module({
  imports: [OrdersModule, MenuModule, NotificationsModule],
  controllers: [PublicMenuController, PublicKioskController],
  providers: [PublicMenuService, PublicKioskService],
})
export class PublicModule {}
