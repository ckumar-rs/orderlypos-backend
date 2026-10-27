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
  createStaffSchema,
  updateStaffSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Auth('users.manage')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.usersService.list(user.restaurantId);
  }

  @Auth('users.manage')
  @Get('roles')
  listRoles(@CurrentUser() user: SessionUser) {
    return this.usersService.listRoles(user.restaurantId);
  }

  @Auth('users.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(createStaffSchema))
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.usersService.create(user.restaurantId, user.id, body as never);
  }

  @Auth('users.manage')
  @Patch(':id')
  @UsePipes(new ZodValidationPipe(updateStaffSchema))
  update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.update(
      user.restaurantId,
      user.id,
      id,
      body as never,
    );
  }

  @Auth('users.manage')
  @Delete(':id')
  remove(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.usersService.remove(user.restaurantId, user.id, id);
  }
}
