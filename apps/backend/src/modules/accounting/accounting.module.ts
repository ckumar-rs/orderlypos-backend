import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { JournalService } from './journal.service';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AuditModule],
  controllers: [AccountingController, LedgerController],
  providers: [
    AccountingService,
    JournalService,
    LedgerService,
    BranchAccessService,
    BranchTimeService,
  ],
  exports: [AccountingService, JournalService],
})
export class AccountingModule {}
