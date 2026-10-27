import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { z } from 'zod';
import { AuditAction } from '../../audit/audit-action';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { LedgerService } from './ledger.service';

const budgetSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  category: z.string().trim().min(1).max(60),
  amount: z.coerce.number().min(0).max(1_000_000_000),
});
const importSchema = z.object({ csv: z.string().min(10).max(2_000_000) });
const statusSchema = z.object({ status: z.enum(['UNMATCHED', 'IGNORED']) });
const matchSchema = z.object({ expenseId: z.string().min(1) });

@ApiTags('accounting')
@Controller('v1/accounting')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('accounting.manage')
  @Get('budgets')
  async budgets(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('month') month: string,
  ) {
    await this.access(u, branchId);
    return this.ledger.budgetVsActual(branchId, month);
  }

  @Auth('accounting.manage')
  @AuditAction('budget.saved', 'Budget')
  @Put('budgets')
  @UsePipes(new ZodValidationPipe(budgetSchema))
  async saveBudget(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: z.infer<typeof budgetSchema>,
  ) {
    await this.access(u, branchId);
    return this.ledger.setBudget(branchId, body);
  }

  @Auth('accounting.manage')
  @AuditAction('budget.deleted', 'Budget')
  @Delete('budgets/:id')
  async deleteBudget(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ledger.deleteBudget(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('bank')
  async bank(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.access(u, branchId);
    return this.ledger.reconciliation(branchId, from, to);
  }

  @Auth('accounting.manage')
  @AuditAction('bank.statement_imported', 'BankTransaction')
  @Post('bank/import')
  @UsePipes(new ZodValidationPipe(importSchema))
  async importBank(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: z.infer<typeof importSchema>,
  ) {
    await this.access(u, branchId);
    return this.ledger.importStatement(branchId, body.csv);
  }

  @Auth('accounting.manage')
  @Post('bank/auto-match')
  async autoMatch(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return { matched: await this.ledger.autoMatch(branchId) };
  }

  @Auth('accounting.manage')
  @Get('bank/:id/candidates')
  async candidates(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ledger.matchCandidates(branchId, id);
  }

  @Auth('accounting.manage')
  @AuditAction('bank.matched', 'BankTransaction')
  @Post('bank/:id/match')
  @UsePipes(new ZodValidationPipe(matchSchema))
  async match(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: z.infer<typeof matchSchema>,
  ) {
    await this.access(u, branchId);
    return this.ledger.matchManually(branchId, id, body.expenseId);
  }

  @Auth('accounting.manage')
  @AuditAction('bank.status_changed', 'BankTransaction')
  @Patch('bank/:id')
  @UsePipes(new ZodValidationPipe(statusSchema))
  async setStatus(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: z.infer<typeof statusSchema>,
  ) {
    await this.access(u, branchId);
    return this.ledger.setBankStatus(branchId, id, body.status);
  }

  @Auth('accounting.manage')
  @Get('balance-sheet')
  async balanceSheet(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('asOf') asOf: string,
  ) {
    await this.access(u, branchId);
    return this.ledger.balanceSheet(branchId, asOf);
  }
}
