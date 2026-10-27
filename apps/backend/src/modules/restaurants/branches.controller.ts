import { Body, Controller, Get, Param, Post, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  copyBranchMenuSchema,
  createBranchSchema,
  type CopyBranchMenuDto,
  type CreateBranchDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { AuditAction } from '../../audit/audit-action';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { BranchesService } from './branches.service';

// Roles that run the whole restaurant see every branch of it; everyone else
// sees only the branches they were assigned to (UserBranch).
const ALL_BRANCH_ROLES = ['OWNER', 'ADMINISTRATOR'];

@ApiTags('branches')
@Controller('v1/branches')
export class BranchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branches: BranchesService,
  ) {}

  @Auth()
  @Get()
  listBranches(@CurrentUser() user: SessionUser) {
    const sees = ALL_BRANCH_ROLES.includes(user.roleName)
      ? {}
      : { users: { some: { userId: user.id } } };
    return this.prisma.branch.findMany({
      where: { restaurantId: user.restaurantId, isActive: true, ...sees },
      orderBy: { name: 'asc' },
    });
  }

  @Auth('settings.manage')
  @AuditAction('branch.created', 'Branch')
  @Post()
  @UsePipes(new ZodValidationPipe(createBranchSchema))
  create(@CurrentUser() user: SessionUser, @Body() body: CreateBranchDto) {
    return this.branches.create(user.restaurantId, user.id, body);
  }

  @Auth('settings.manage')
  @AuditAction('branch.menu_copied', 'Branch')
  @Post(':id/copy-menu')
  @UsePipes(new ZodValidationPipe(copyBranchMenuSchema))
  copyMenu(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: CopyBranchMenuDto,
  ) {
    return this.branches.copyMenu(user.restaurantId, id, body.sourceBranchId);
  }
}
