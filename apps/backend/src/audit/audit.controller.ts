import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  auditLogListQuerySchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit-logs')
@Controller('v1/audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Auth('audit_log.view')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query() query: Record<string, string>,
  ) {
    const result = auditLogListQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return this.auditService.list(user.restaurantId, result.data);
  }

  @Auth('audit_log.view')
  @Get('entities')
  async entities(@CurrentUser() user: SessionUser) {
    return this.auditService.listEntities(user.restaurantId);
  }
}
