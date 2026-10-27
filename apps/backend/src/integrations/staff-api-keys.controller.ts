import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createStaffApiKeySchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { AuditAction } from '../audit/audit-action';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StaffApiKeysService } from './staff-api-keys.service';

// Any logged-in staff member manages their own personal keys — no special
// permission required beyond being authenticated, same as Zulivio's
// equivalent: this is "give myself a key," not a restaurant-wide grant.
@ApiTags('integrations')
@Controller('v1/staff-api-keys')
export class StaffApiKeysController {
  constructor(private readonly staffApiKeys: StaffApiKeysService) {}

  @Auth()
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.staffApiKeys.list(user);
  }

  @Auth()
  @AuditAction('api_key.personal_created', 'StaffApiKey')
  @Post()
  @UsePipes(new ZodValidationPipe(createStaffApiKeySchema))
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.staffApiKeys.create(user, body as never);
  }

  @Auth()
  @AuditAction('api_key.personal_revoked', 'StaffApiKey')
  @Delete(':id')
  revoke(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.staffApiKeys.revoke(user, id);
  }
}
