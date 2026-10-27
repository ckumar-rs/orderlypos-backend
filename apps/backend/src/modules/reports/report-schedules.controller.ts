import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { EmailService } from '../email/email.service';
import { assertCanViewReport } from './reports.service';
import { ReportSchedulesService } from './report-schedules.service';

const createSchema = z.object({
  reportKey: z.string().min(1).max(60),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  recipients: z.array(z.string().email()).min(1).max(10),
});
const activeSchema = z.object({ isActive: z.boolean() });

@ApiTags('reports')
@Controller('v1/report-schedules')
export class ReportSchedulesController {
  constructor(
    private readonly schedules: ReportSchedulesService,
    private readonly email: EmailService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('reports.access', 'data.export')
  @Get()
  async list(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return {
      emailConfigured: this.email.isConfigured(),
      schedules: await this.schedules.list(branchId),
    };
  }

  @Auth('reports.access', 'data.export')
  @AuditAction('report_schedule.created', 'ReportSchedule')
  @Post()
  @UsePipes(new ZodValidationPipe(createSchema))
  async create(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: z.infer<typeof createSchema>,
  ) {
    assertCanViewReport(u.permissions, body.reportKey);
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.schedules.create(branchId, body);
  }

  @Auth('reports.access', 'data.export')
  @Patch(':id')
  @UsePipes(new ZodValidationPipe(activeSchema))
  async toggle(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: z.infer<typeof activeSchema>,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.schedules.setActive(branchId, id, body.isActive);
  }

  @Auth('reports.access', 'data.export')
  @Post(':id/send')
  async sendNow(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.schedules.sendNow(branchId, id);
  }

  @Auth('reports.access', 'data.export')
  @AuditAction('report_schedule.deleted', 'ReportSchedule')
  @Delete(':id')
  async remove(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.schedules.remove(branchId, id);
  }
}
