import { z } from "zod";

export const spiceLevelSchema = z.enum(["NONE", "MILD", "MEDIUM", "HOT", "EXTRA_HOT"]);

export const menuCategorySchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  showOnWebsite: z.boolean().default(true),
  parentId: z.string().optional().nullable(),
});
export type MenuCategoryDto = z.infer<typeof menuCategorySchema>;

export const salesChannelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  orderType: z
    .enum([
      "DINE_IN",
      "TAKEAWAY",
      "DELIVERY",
      "DRIVE_THRU",
      "QR_ORDER",
      "KIOSK",
      "PHONE",
    ])
    .optional()
    .nullable(),
  foodPlatform: z.enum(["ZOMATO", "SWIGGY"]).optional().nullable(),
  markupPercent: z.coerce.number().min(-90).max(400).default(0),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type SalesChannelDto = z.infer<typeof salesChannelSchema>;

export const menuItemChannelPricesSchema = z.object({
  prices: z.array(
    z.object({
      channelId: z.string().min(1),
      price: z.coerce.number().nonnegative(),
    }),
  ),
});
export type MenuItemChannelPricesDto = z.infer<typeof menuItemChannelPricesSchema>;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const menuSetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  isForced: z.boolean().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  startTime: clock.optional().nullable(),
  endTime: clock.optional().nullable(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  menuItemIds: z.array(z.string()).optional(),
});
export type MenuSetDto = z.infer<typeof menuSetSchema>;

export const menuPriceRuleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  menuItemId: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  ingredientId: z.string().optional().nullable(),
  percent: z.coerce.number().min(-90).max(200),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  startTime: clock.optional().nullable(),
  endTime: clock.optional().nullable(),
  stockBelow: z.coerce.number().min(0).optional().nullable(),
  demandQty: z.coerce.number().int().positive().optional().nullable(),
  demandHours: z.coerce.number().int().min(1).max(168).optional().nullable(),
  isActive: z.boolean().optional(),
});
export type MenuPriceRuleDto = z.infer<typeof menuPriceRuleSchema>;

export const modifierSchema = z.object({
  name: z.string().min(1),
  imageUrl: z.string().trim().max(2048).optional().nullable(),
  priceAdjustment: z.coerce.number().default(0),
  taxRatePercent: z.coerce.number().optional(),
  kitchenNote: z.string().optional(),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type ModifierDto = z.infer<typeof modifierSchema>;

export const modifierImageSchema = z.object({
  imageUrl: z.string().trim().max(2048).nullable(),
});
export type ModifierImageDto = z.infer<typeof modifierImageSchema>;

export const modifierGroupSchema = z.object({
  name: z.string().min(1),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  isRequired: z.boolean().default(false),
  modifiers: z.array(modifierSchema).default([]),
});
export type ModifierGroupDto = z.infer<typeof modifierGroupSchema>;

export const menuItemSchema = z.object({
  categoryId: z.string(),
  stationId: z.string().optional(),
  courseId: z.string().optional().nullable(),
  name: z.string().min(1),
  sku: z.string().trim().max(64).optional().nullable(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  price: z.coerce.number().nonnegative(),
  // Set to enable the Half / Full / Custom portion picker; `price` is the full portion.
  halfPrice: z.number().nonnegative().nullable().optional(),
  taxRatePercent: z.coerce.number().min(0).max(100).default(0),
  costPrice: z.coerce.number().nonnegative().optional(),
  prepTimeMinutes: z.number().int().nonnegative().optional(),
  calories: z.number().int().nonnegative().optional(),
  isVeg: z.boolean().default(true),
  isVegan: z.boolean().default(false),
  isJain: z.boolean().default(false),
  isHalal: z.boolean().default(false),
  isGlutenFree: z.boolean().default(false),
  spiceLevel: spiceLevelSchema.default("NONE"),
  allergens: z.array(z.string()).default([]),
  availableFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  availableTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  barcode: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable(),
  soldByWeight: z.boolean().optional(),
  hsnCode: z.string().trim().max(16).optional().nullable(),
  isActive: z.boolean().default(true),
  modifierGroupIds: z.array(z.string()).default([]),
  sizes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        price: z.coerce.number().nonnegative(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .optional(),
});
export type MenuItemDto = z.infer<typeof menuItemSchema>;
