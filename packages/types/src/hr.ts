import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const shiftSchema = z
  .object({
    userId: z.string().min(1),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    note: z.string().max(200).optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "A shift must end after it starts",
    path: ["endsAt"],
  });
export type ShiftDto = z.infer<typeof shiftSchema>;

export const leaveTypeSchema = z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]);
export type LeaveTypeDto = z.infer<typeof leaveTypeSchema>;

export const leaveRequestSchema = z
  .object({
    branchId: z.string().min(1),
    type: leaveTypeSchema.default("ANNUAL"),
    startDate: isoDate,
    endDate: isoDate,
    reason: z.string().max(300).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "End date cannot be before start date",
    path: ["endDate"],
  });
export type LeaveRequestDto = z.infer<typeof leaveRequestSchema>;

/** Manager books leave on behalf of a staff member. */
export const managerLeaveSchema = z
  .object({
    userId: z.string().min(1),
    type: leaveTypeSchema.default("ANNUAL"),
    startDate: isoDate,
    endDate: isoDate,
    reason: z.string().max(300).optional(),
    /** When true, create already APPROVED (skips the pending queue). */
    approveNow: z.boolean().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "End date cannot be before start date",
    path: ["endDate"],
  });
export type ManagerLeaveDto = z.infer<typeof managerLeaveSchema>;

export const leaveDecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
});

export const leaveBalanceSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(["ANNUAL", "SICK"]),
  year: z.coerce.number().int().min(2000).max(2100),
  entitledDays: z.coerce.number().min(0).max(366),
});
export type LeaveBalanceDto = z.infer<typeof leaveBalanceSchema>;

export const staffPaySchema = z.object({
  payType: z.enum(["MONTHLY", "HOURLY"]),
  rate: z.coerce.number().min(0),
});
export type StaffPayDto = z.infer<typeof staffPaySchema>;

export const payrollRunSchema = z
  .object({ periodStart: isoDate, periodEnd: isoDate })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: "Period end cannot be before start",
    path: ["periodEnd"],
  });
export type PayrollRunDto = z.infer<typeof payrollRunSchema>;

export const performanceReviewSchema = z
  .object({
    userId: z.string().min(1),
    periodStart: isoDate,
    periodEnd: isoDate,
    rating: z.coerce.number().int().min(1).max(5),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: "Period end cannot be before start",
    path: ["periodEnd"],
  });
export type PerformanceReviewDto = z.infer<typeof performanceReviewSchema>;
