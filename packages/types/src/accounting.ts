import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const expenseSchema = z.object({
  spentOn: isoDate,
  category: z.string().trim().min(1).max(60),
  amount: z.coerce.number().positive(),
  note: z.string().max(300).optional(),
  paidFromCash: z.boolean().default(false),
});
export type ExpenseDto = z.infer<typeof expenseSchema>;

export const expenseDecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
});
export type ExpenseDecisionDto = z.infer<typeof expenseDecisionSchema>;

export const pettyCashSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  amount: z.coerce.number().positive(),
  reason: z.string().trim().min(1).max(200),
  spentOn: isoDate,
});
export type PettyCashDto = z.infer<typeof pettyCashSchema>;

export const cashClosingSchema = z.object({
  businessDate: isoDate,
  openingFloat: z.coerce.number().min(0).default(0),
  countedCash: z.coerce.number().min(0),
  note: z.string().max(300).optional(),
});
export type CashClosingDto = z.infer<typeof cashClosingSchema>;

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;

export const ledgerAccountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(80),
  type: z.enum(ACCOUNT_TYPES),
  isActive: z.boolean().optional(),
});
export type LedgerAccountDto = z.infer<typeof ledgerAccountSchema>;

export const ledgerAccountMapSchema = z.object({
  sourceKey: z.string().trim().min(1).max(40),
  accountId: z.string().min(1),
});
export type LedgerAccountMapDto = z.infer<typeof ledgerAccountMapSchema>;

export const journalLineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
});

export const journalVoucherSchema = z.object({
  postedOn: isoDate,
  narration: z.string().trim().min(1).max(300),
  number: z.string().trim().max(40).optional(),
  lines: z.array(journalLineSchema).min(2).max(40),
});
export type JournalVoucherDto = z.infer<typeof journalVoucherSchema>;

export const tallyPushSchema = z.object({
  from: isoDate,
  to: isoDate,
});
export type TallyPushDto = z.infer<typeof tallyPushSchema>;

export const syncIngestSchema = z.object({
  sourceBranchId: z.string().min(1),
  sourceBranchName: z.string().trim().min(1).max(80),
  events: z
    .array(
      z.object({
        entityType: z.string().min(1).max(40),
        entityId: z.string().min(1),
        occurredAt: z.string().min(1),
        payload: z.unknown(),
      }),
    )
    .min(1)
    .max(200),
});
export type SyncIngestDto = z.infer<typeof syncIngestSchema>;
