import { z } from "zod";

export const customerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  birthday: z.coerce.date().optional(),
  anniversary: z.coerce.date().optional(),
  allergies: z.string().optional(),
  notes: z.string().optional(),
  marketingOptOut: z.boolean().optional(),
  gstStateCode: z.string().trim().max(2).optional(),
  referralCode: z.string().trim().max(16).optional(),
  referredByCode: z.string().trim().max(16).optional(),
});
export type CustomerDto = z.infer<typeof customerSchema>;

export const membershipTierSchema = z.object({
  name: z.string().trim().min(1).max(40),
  minPoints: z.coerce.number().int().nonnegative(),
  earnMultiplier: z.coerce.number().positive().max(10).optional(),
});
export type MembershipTierDto = z.infer<typeof membershipTierSchema>;

export const rfmLabelSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    minR: z.coerce.number().int().min(1).max(5),
    maxR: z.coerce.number().int().min(1).max(5),
    minF: z.coerce.number().int().min(1).max(5),
    maxF: z.coerce.number().int().min(1).max(5),
    minM: z.coerce.number().int().min(1).max(5),
    maxM: z.coerce.number().int().min(1).max(5),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  })
  .refine((v) => v.minR <= v.maxR && v.minF <= v.maxF && v.minM <= v.maxM, {
    message: "Each RFM min must be at most its max",
  });
export type RfmLabelDto = z.infer<typeof rfmLabelSchema>;

export const outboundTestSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  to: z.string().trim().min(8).max(20),
  body: z.string().trim().min(1).max(1000),
});
export type OutboundTestDto = z.infer<typeof outboundTestSchema>;

export const guestProfileSchema = z.object({
  token: z.string().min(8).max(80),
  phone: z.string().trim().min(8).max(20),
  name: z.string().trim().max(80).optional(),
  referralCode: z.string().trim().max(16).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type GuestProfileDto = z.infer<typeof guestProfileSchema>;

const blankOrNull = z.union([z.null(), z.coerce.number()]);

export const loyaltyRuleSchema = z.object({
  earnPerCurrency: blankOrNull.pipe(z.number().int().positive().max(100000).nullable()).optional(),
  pointValue: blankOrNull.pipe(z.number().positive().max(10000).nullable()).optional(),
  maxEarnPerOrder: blankOrNull.pipe(z.number().int().positive().max(100000).nullable()).optional(),
  maxRedeemPerOrder: blankOrNull.pipe(z.number().int().positive().max(100000).nullable()).optional(),
  expiryDays: blankOrNull.pipe(z.number().int().positive().max(3650).nullable()).optional(),
  eligibleMenuItemIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  cashbackPercent: z.coerce.number().min(0).max(100).optional(),
  cashbackCap: blankOrNull.pipe(z.number().min(0).max(100000).nullable()).optional(),
});
export type LoyaltyRuleDto = z.infer<typeof loyaltyRuleSchema>;

export const rewardSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    pointsCost: z.coerce.number().int().min(0).max(1_000_000).optional(),
    cashbackCost: z.coerce.number().min(0).max(100_000).optional(),
  })
  .refine((value) => (value.pointsCost ?? 0) > 0 || (value.cashbackCost ?? 0) > 0, {
    message: "A reward needs a points cost or a cashback cost",
  });
export type RewardDto = z.infer<typeof rewardSchema>;

export const employeeDiscountPolicySchema = z
  .object({
    userId: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
    percent: z.coerce.number().min(0).max(100),
    maxAmount: blankOrNull.pipe(z.number().min(0).max(100_000).nullable()).optional(),
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.roleId), {
    message: "Choose one staff member or one role",
  });
export type EmployeeDiscountPolicyDto = z.infer<typeof employeeDiscountPolicySchema>;
