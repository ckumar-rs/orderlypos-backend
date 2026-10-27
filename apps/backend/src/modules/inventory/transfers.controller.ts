import { Body, Controller, Get, Post, Query, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { z } from 'zod';
import { AuditAction } from '../../audit/audit-action';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { TransfersService } from './transfers.service';

const transferSchema = z.object({
  toBranchId: z.string().min(1),
  ingredientId: z.string().min(1),
  quantity: z.coerce.number().positive().max(1_000_000),
  note: z.string().trim().max(200).optional(),
});

@ApiTags('inventory')
@Controller('v1/inventory/transfers')
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('inventory.manage')
  @Get()
  async list(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    const [history, branches] = await Promise.all([
      this.transfers.list(u.restaurantId, branchId),
      this.transfers.otherBranches(u.restaurantId, branchId),
    ]);
    return { history, branches };
  }

  @Auth('inventory.manage')
  @AuditAction('stock.transferred', 'StockTransfer')
  @Post()
  @UsePipes(new ZodValidationPipe(transferSchema))
  async create(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: z.infer<typeof transferSchema>,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.transfers.transfer(u.restaurantId, u.id, branchId, body);
  }
}
