import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { ApiTags } from '@nestjs/swagger';
import {
  cashClosingAdjustSchema,
  cashClosingSchema,
  expenseDecisionSchema,
  expenseSchema,
  journalVoucherSchema,
  ledgerAccountMapSchema,
  ledgerAccountSchema,
  ledgerAccountUpdateSchema,
  periodLockSchema,
  pettyCashSchema,
  tallyPushSchema,
  type CashClosingAdjustDto,
  type CashClosingDto,
  type ExpenseDecisionDto,
  type ExpenseDto,
  type JournalVoucherDto,
  type LedgerAccountDto,
  type LedgerAccountMapDto,
  type LedgerAccountUpdateDto,
  type PeriodLockDto,
  type PettyCashDto,
  type SessionUser,
  type TallyPushDto,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { AuditAction } from '../../audit/audit-action';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { connectorJson, tallyVoucherXml } from './tally';
import { AccountingService } from './accounting.service';
import { JournalService } from './journal.service';

@ApiTags('accounting')
@Controller('v1/accounting')
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly journal: JournalService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('accounting.manage')
  @Get('expenses')
  async expenses(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listExpenses(branchId, from, to);
  }

  @Auth('expense.create')
  @AuditAction('expense.created', 'Expense')
  @Post('expenses')
  @UsePipes(new ZodValidationPipe(expenseSchema))
  async createExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: ExpenseDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.createExpense(branchId, u.id, body);
  }

  @Auth('expense.create')
  @AuditAction('expense.attachment', 'Expense')
  @Post('expenses/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  async attachExpenseFile(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    await this.access(u, branchId);
    if (!file) throw new BadRequestException('Choose a file (max 5 MB)');
    return this.accounting.addExpenseAttachment(branchId, id, file);
  }

  @Auth('accounting.manage')
  @Get('expenses/:id/attachments/:fileId')
  async downloadExpenseFile(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const file = await this.accounting.getExpenseAttachment(branchId, id, fileId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/"/g, '')}"`,
    );
    res.send(Buffer.from(file.data));
  }

  @Auth('accounting.manage')
  @Delete('expenses/:id/attachments/:fileId')
  async deleteExpenseFile(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.deleteExpenseAttachment(branchId, id, fileId);
  }

  @Auth('accounting.manage')
  @AuditAction('expense.updated', 'Expense')
  @Patch('expenses/:id')
  @UsePipes(new ZodValidationPipe(expenseSchema))
  async updateExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: ExpenseDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.updateExpense(branchId, id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('expense.deleted', 'Expense')
  @Delete('expenses/:id')
  async deleteExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.deleteExpense(branchId, id);
  }

  @Auth('accounting.manage')
  @AuditAction('expense.decided', 'Expense')
  @Post('expenses/:id/decision')
  @UsePipes(new ZodValidationPipe(expenseDecisionSchema))
  async decideExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: ExpenseDecisionDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.decideExpense(branchId, id, u.id, body.status);
  }

  @Auth('accounting.manage')
  @Get('petty-cash')
  async pettyCash(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    const [entries, balance] = await Promise.all([
      this.accounting.listPettyCash(branchId, from, to),
      this.accounting.pettyBalance(branchId),
    ]);
    return { balance, entries };
  }

  @Auth('accounting.manage')
  @AuditAction('petty_cash.recorded', 'PettyCashEntry')
  @Post('petty-cash')
  @UsePipes(new ZodValidationPipe(pettyCashSchema))
  async addPettyCash(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: PettyCashDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.addPettyCash(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('petty_cash.updated', 'PettyCashEntry')
  @Patch('petty-cash/:id')
  @UsePipes(new ZodValidationPipe(pettyCashSchema))
  async updatePettyCash(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: PettyCashDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.updatePettyCash(branchId, id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('petty_cash.deleted', 'PettyCashEntry')
  @Delete('petty-cash/:id')
  async deletePettyCash(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.deletePettyCash(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('tally')
  async tally(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const { companyName, vouchers } = await this.accounting.accountingExport(
      branchId,
      from,
      to,
    );
    const body = tallyVoucherXml(companyName, vouchers);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="tally-vouchers.xml"',
    );
    res.send(body);
  }

  @Auth('accounting.manage')
  @Get('connectors')
  async connectors(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    const { companyName, vouchers } = await this.accounting.accountingExport(
      branchId,
      from,
      to,
    );
    return connectorJson(companyName, vouchers);
  }

  @Auth('accounting.manage')
  @Get('closing/preview')
  async preview(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('date') date: string,
    @Query('openingFloat') openingFloat?: string,
  ) {
    await this.access(u, branchId);
    const float =
      openingFloat === undefined || openingFloat === ''
        ? undefined
        : Number(openingFloat);
    return this.accounting.closingPreview(branchId, date, float);
  }

  @Auth('accounting.manage')
  @Get('closing')
  async closings(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listClosings(branchId);
  }

  @Auth('accounting.manage')
  @AuditAction('cash.closed', 'CashClosing')
  @Post('closing')
  @UsePipes(new ZodValidationPipe(cashClosingSchema))
  async close(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: CashClosingDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.closeDay(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('cash.reopened', 'CashClosing')
  @Post('closing/:id/reopen')
  async reopenClosing(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.reopenDay(branchId, id);
  }

  @Auth('accounting.manage')
  @AuditAction('cash.adjusted', 'CashClosing')
  @Patch('closing/:id')
  @UsePipes(new ZodValidationPipe(cashClosingAdjustSchema))
  async adjustClosing(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: CashClosingAdjustDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.adjustClosing(branchId, id, body);
  }

  @Auth('accounting.manage')
  @Get('profit-loss')
  async pnl(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.profitAndLoss(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Get('profit-loss/export')
  async pnlExport(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const pnl = await this.accounting.profitAndLoss(branchId, from, to);
    const csv = this.accounting.profitAndLossCsv(pnl);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="profit-loss-${from}-${to}.csv"`,
    );
    res.send(csv);
  }

  @Auth('accounting.manage')
  @Get('profit-loss/consolidated')
  consolidatedPnl(
    @CurrentUser() u: SessionUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.accounting.consolidatedProfitAndLoss(u.restaurantId, from, to);
  }

  @Auth('accounting.manage')
  @Get('gst')
  async gst(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.gstReport(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Get('gst/export')
  async gstExport(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const gst = await this.accounting.gstReport(branchId, from, to);
    const csv = this.accounting.gstCsv(gst);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gst-${from}-${to}.csv"`,
    );
    res.send(csv);
  }

  @Auth('accounting.manage')
  @Get('gst/billing')
  async gstBilling(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.gstBilling(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Get('gst/gstr1')
  async gstr1(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const body = await this.accounting.gstr1Export(branchId, from, to);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gstr1-${from}-${to}.json"`,
    );
    res.send(JSON.stringify(body, null, 2));
  }

  @Auth('accounting.manage')
  @Get('branches')
  branches(
    @CurrentUser() u: SessionUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.accounting.branchOverview(u.restaurantId, from, to);
  }

  @Auth('accounting.manage')
  @Get('period-locks')
  async periodLocks(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listPeriodLocks(branchId);
  }

  @Auth('accounting.manage')
  @AuditAction('period.locked', 'AccountingPeriodLock')
  @Post('period-locks')
  @UsePipes(new ZodValidationPipe(periodLockSchema))
  async createPeriodLock(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: PeriodLockDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.createPeriodLock(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('period.unlocked', 'AccountingPeriodLock')
  @Delete('period-locks/:id')
  async deletePeriodLock(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.deletePeriodLock(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('till-history')
  async tillHistory(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listTillHistory(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Post('tally/ping')
  async pingTally(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.pingTally(branchId);
  }

  @Auth('accounting.manage')
  @AuditAction('tally.posted', 'TallyPost')
  @Post('tally/push')
  @UsePipes(new ZodValidationPipe(tallyPushSchema))
  async pushTally(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: TallyPushDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.pushTally(branchId, body.from, body.to);
  }

  @Auth('accounting.manage')
  @Get('tally/posts')
  async tallyPosts(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listTallyPosts(branchId);
  }

  @Auth('accounting.manage')
  @Get('accounts')
  async accounts(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.journal.listAccounts(branchId);
  }

  @Auth('accounting.manage')
  @Post('accounts')
  @UsePipes(new ZodValidationPipe(ledgerAccountSchema))
  async createAccount(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: LedgerAccountDto,
  ) {
    await this.access(u, branchId);
    return this.journal.createAccount(branchId, body);
  }

  @Auth('accounting.manage')
  @Post('accounts/seed-defaults')
  async seedAccounts(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.journal.ensureDefaultCoa(branchId);
  }

  @Auth('accounting.manage')
  @Patch('accounts/:id')
  @UsePipes(new ZodValidationPipe(ledgerAccountUpdateSchema))
  async updateAccount(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: LedgerAccountUpdateDto,
  ) {
    await this.access(u, branchId);
    return this.journal.updateAccount(branchId, id, body);
  }

  @Auth('accounting.manage')
  @Delete('accounts/:id')
  async deleteAccount(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.journal.deleteAccount(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('account-maps')
  async accountMaps(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.journal.listMaps(branchId);
  }

  @Auth('accounting.manage')
  @Post('account-maps')
  @UsePipes(new ZodValidationPipe(ledgerAccountMapSchema))
  async upsertMap(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: LedgerAccountMapDto,
  ) {
    await this.access(u, branchId);
    return this.journal.upsertMap(branchId, body);
  }

  @Auth('accounting.manage')
  @Delete('account-maps/:id')
  async deleteMap(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.journal.deleteMap(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('journals')
  async journals(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.journal.listJournals(branchId, from, to);
  }

  @Auth('accounting.manage')
  @AuditAction('journal.posted', 'JournalVoucher')
  @Post('journals')
  @UsePipes(new ZodValidationPipe(journalVoucherSchema))
  async postJournal(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: JournalVoucherDto,
  ) {
    await this.access(u, branchId);
    await this.accounting.assertUnlocked(branchId, body.postedOn);
    return this.journal.postJournal(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('journal.reversed', 'JournalVoucher')
  @Post('journals/:id/reverse')
  async reverseJournal(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    // Reversals post with today's date — block when today is locked.
    await this.accounting.assertUnlocked(
      branchId,
      new Date().toISOString().slice(0, 10),
    );
    return this.journal.reverseJournal(branchId, u.id, id);
  }

  @Auth('accounting.manage')
  @Get('trial-balance')
  async trialBalance(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.journal.trialBalance(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Post('journals/auto-post')
  async autoPost(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.journal.autoPostMissing(branchId, u.id);
  }
}
