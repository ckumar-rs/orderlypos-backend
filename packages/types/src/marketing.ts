import { z } from "zod";

export const discountKindSchema = z.enum(["PERCENT", "FLAT", "BOGO"]);

const discountValue = (kind: "PERCENT" | "FLAT", value: number) =>
  kind === "FLAT" || value <= 100;

export const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(24)
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only"),
    kind: z.enum(["PERCENT", "FLAT"]),
    value: z.coerce.number().positive(),
    minOrderAmount: z.coerce.number().min(0).default(0),
    maxDiscount: z.coerce.number().positive().optional(),
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
    usageLimit: z.coerce.number().int().positive().optional(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => discountValue(v.kind, v.value), {
    message: "A percentage discount cannot exceed 100",
    path: ["value"],
  });
export type CouponDto = z.infer<typeof couponSchema>;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const promotionSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: discountKindSchema,
    value: z.coerce.number().min(0),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    startTime: time,
    endTime: time,
    isActive: z.boolean().default(true),
    buyQuantity: z.coerce.number().int().min(1).optional(),
    getQuantity: z.coerce.number().int().min(1).optional(),
    audience: z.enum(["ALL", "STAFF"]).optional(),
    categoryId: z.string().optional().nullable(),
    minOrderAmount: z.coerce.number().min(0).optional(),
    customerId: z.string().optional().nullable(),
    weatherCode: z.string().trim().max(40).optional().nullable(),
    bundleMenuItemId: z.string().optional().nullable(),
    allDay: z.boolean().optional(),
  })
  .refine((v) => v.kind === "BOGO" || discountValue(v.kind, v.value), {
    message: "A percentage discount cannot exceed 100",
    path: ["value"],
  })
  .refine((v) => v.startTime < v.endTime, {
    message: "End time must be after start time",
    path: ["endTime"],
  });
export type PromotionDto = z.infer<typeof promotionSchema>;

export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(80),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP"]),
  segment: z.enum(["ALL", "LOYAL", "LAPSED", "BIRTHDAY_MONTH", "TIER", "RFM"]).default("ALL"),
  tierId: z.string().optional(),
  rfmLabel: z.string().trim().min(1).max(40).optional(),
  message: z.string().trim().min(1).max(600),
});
export type CampaignDto = z.infer<typeof campaignSchema>;

export const equipmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  location: z.string().trim().max(80).optional(),
  serviceIntervalDays: z.coerce.number().int().positive().optional(),
  lastServicedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(300).optional(),
});
export type EquipmentDto = z.infer<typeof equipmentSchema>;

export const serviceLogSchema = z.object({
  servicedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cost: z.coerce.number().min(0).optional(),
  note: z.string().max(300).optional(),
});
export type ServiceLogDto = z.infer<typeof serviceLogSchema>;

export const documentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(["SOP", "CONTRACT", "RECIPE", "PURCHASE", "OTHER"]).default("SOP"),
  body: z.string().min(1).max(50_000),
});
export type DocumentDto = z.infer<typeof documentSchema>;
export const documentUpdateSchema = documentSchema.partial();

// checkout may carry a coupon code
export const couponCodeSchema = z.string().trim().min(3).max(24);
