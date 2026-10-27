import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  notificationListQuerySchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

// No extra permission gate beyond authenticated — every staff member can
// see and manage their own notifications, regardless of role. Recipients
// are already resolved server-side at creation time (notifyByPermission /
// notifyUser), and every query here is scoped to the caller's own userId,
// so there's nothing further to gate.
@ApiTags('notifications')
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Auth()
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, string>,
  ) {
    const result = notificationListQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return this.notificationsService.list(user.id, result.data);
  }

  @Auth()
  @Patch(':id/read')
  markRead(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.notificationsService.markRead(user.id, id);
  }

  @Auth()
  @Patch('read-all')
  markAllRead(@CurrentUser() user: SessionUser) {
    return this.notificationsService.markAllRead(user.id);
  }
}
