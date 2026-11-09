import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DemoPlatformStatusDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class DemoFlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async assertDemo(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { demoMode: true },
    });
    if (!restaurant?.demoMode) {
      throw new ForbiddenException(
        'Turn on Demo mode in Settings to use simulated payments and messages',
      );
    }
  }

  async sendReceipt(
    restaurantId: string,
    branchId: string,
    orderId: string,
    phone: string,
  ) {
    await this.assertDemo(restaurantId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      select: { id: true, orderNumber: true, totalAmount: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const body = `Demo only. A receipt for order ${order.orderNumber} (${order.totalAmount}) was shown as sent to ${phone}. WhatsApp was not contacted.`;
    await this.notifications.notifyByPermission(branchId, 'settings.manage', {
      type: 'demo.whatsapp',
      title: 'Demo WhatsApp receipt',
      body,
      entity: 'Order',
      entityId: order.id,
    });
    return { demo: true, phone, message: body };
  }

  async setPlatformStatus(
    restaurantId: string,
    branchId: string,
    orderId: string,
    dto: DemoPlatformStatusDto,
  ) {
    await this.assertDemo(restaurantId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      select: { id: true, orderNumber: true, foodPlatform: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.foodPlatform) {
      throw new BadRequestException(
        'This order did not come from Zomato or Swiggy',
      );
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: { demoPlatformStatus: dto.status },
    });
    const body = `Demo only. ${order.foodPlatform} was shown as updated to ${dto.status} for order ${order.orderNumber}. The platform was not contacted.`;
    await this.notifications.notifyByPermission(branchId, 'settings.manage', {
      type: 'demo.platform',
      title: `Demo ${order.foodPlatform} status`,
      body,
      entity: 'Order',
      entityId: order.id,
    });
    return { demo: true, platform: order.foodPlatform, status: dto.status };
  }
}
