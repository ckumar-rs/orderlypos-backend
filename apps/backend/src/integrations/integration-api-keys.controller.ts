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
  createIntegrationApiKeySchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { AuditAction } from '../audit/audit-action';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { IntegrationApiKeysService } from './integration-api-keys.service';

@ApiTags('integrations')
@Controller('v1/integration-api-keys')
export class IntegrationApiKeysController {
  constructor(private readonly integrationApiKeys: IntegrationApiKeysService) {}

  @Auth('settings.manage')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.integrationApiKeys.list(user);
  }

  @Auth('settings.manage')
  @AuditAction('api_key.integration_created', 'IntegrationApiKey')
  @Post()
  @UsePipes(new ZodValidationPipe(createIntegrationApiKeySchema))
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.integrationApiKeys.create(user, body as never);
  }

  @Auth('settings.manage')
  @AuditAction('api_key.integration_revoked', 'IntegrationApiKey')
  @Delete(':id')
  revoke(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.integrationApiKeys.revoke(user, id);
  }
}
