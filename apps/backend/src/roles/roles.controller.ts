import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createRoleSchema,
  updateRoleSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RolesService } from './roles.service';

@ApiTags('roles')
@Controller('v1/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Auth('roles.manage')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.rolesService.list(user.restaurantId);
  }

  @Auth('roles.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(createRoleSchema))
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.rolesService.create(user.restaurantId, user.id, body as never);
  }

  @Auth('roles.manage')
  @Patch(':id')
  @UsePipes(new ZodValidationPipe(updateRoleSchema))
  update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rolesService.update(
      user.restaurantId,
      user.id,
      id,
      body as never,
    );
  }

  @Auth('roles.manage')
  @Delete(':id')
  remove(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.rolesService.remove(user.restaurantId, user.id, id);
  }
}
