import { z } from "zod";
import { paymentMethodSchema } from "./orders";

export const ingredientUnitSchema = z.enum([
  "KG",
  "G",
  "L",
  "ML",
  "PIECE",
  "DOZEN",
  "PACK",
  "BOX",
]);
export type IngredientUnit = z.infer<typeof ingredientUnitSchema>;

export const ingredientSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  unit: ingredientUnitSchema,
  // Stock units in one purchase unit. 1 keeps the purchase and the recipe in the same unit.
  purchaseToBase: z.coerce.number().positive().max(1_000_000).optional(),
  reorderLevel: z.coerce.number().nonnegative().default(0),
  leadTimeDays: z.coerce.number().nonnegative().max(90).optional().nullable(),
  isActive: z.boolean().default(true),
});
export type IngredientDto = z.infer<typeof ingredientSchema>;

export const stockAdjustmentSchema = z.object({
  quantity: z.coerce.number(), // signed: positive to add, negative to remove
  note: z.string().min(1),
});
export type StockAdjustmentDto = z.infer<typeof stockAdjustmentSchema>;

export const recipeLineSchema = z.object({
  ingredientId: z.string(),
  quantity: z.coerce.number().positive(),
  unit: ingredientUnitSchema.optional(),
});
export type RecipeLineDto = z.infer<typeof recipeLineSchema>;

export const setRecipeSchema = z.object({
  lines: z.array(recipeLineSchema),
  servings: z.coerce.number().int().min(1).max(10_000).optional(),
  yieldQuantity: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  yieldUnit: z.string().trim().max(20).nullable().optional(),
  instructions: z.string().trim().max(4000).nullable().optional(),
  portionStep: z.coerce.number().positive().max(1000).optional(),
  effectiveFrom: z.string().max(40).optional(),
});

export const unitConversionSchema = z.object({
  fromUnit: ingredientUnitSchema,
  toUnit: ingredientUnitSchema,
  factor: z.coerce.number().positive().max(1_000_000),
});
export type UnitConversionDto = z.infer<typeof unitConversionSchema>;
export type SetRecipeDto = z.infer<typeof setRecipeSchema>;

export const inventoryTrackingSchema = z.enum(["NONE", "RECIPE", "DIRECT"]);
export type InventoryTrackingDto = z.infer<typeof inventoryTrackingSchema>;

// How selling a menu item moves stock (see InventoryTracking in schema.prisma).
export const menuItemTrackingSchema = z
  .object({
    inventoryTracking: inventoryTrackingSchema,
    stockIngredientId: z.string().min(1).nullable().optional(),
    stockQuantityPerSale: z.coerce.number().positive().max(100000).optional(),
  })
  .refine((v) => v.inventoryTracking !== "DIRECT" || !!v.stockIngredientId, {
    message: "Pick the stock item this product deducts from",
    path: ["stockIngredientId"],
  });
export type MenuItemTrackingDto = z.infer<typeof menuItemTrackingSchema>;

export const supplierSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().default(true),
});
export type SupplierDto = z.infer<typeof supplierSchema>;

export const purchaseOrderItemSchema = z.object({
  ingredientId: z.string(),
  quantityOrdered: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
});
export type PurchaseOrderItemDto = z.infer<typeof purchaseOrderItemSchema>;

export const purchaseOrderSchema = z.object({
  supplierId: z.string(),
  expectedDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  items: z.array(purchaseOrderItemSchema).min(1),
});
export type PurchaseOrderDto = z.infer<typeof purchaseOrderSchema>;

export const purchaseOrderStatusSchema = z.enum([
  "DRAFT",
  "SENT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
]);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const goodsReceiptItemSchema = z.object({
  ingredientId: z.string(),
  purchaseOrderItemId: z.string().optional(),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
  batchNumber: z.string().optional(), // auto-generated server-side if omitted
  expiryDate: z.coerce.date().optional(),
});
export type GoodsReceiptItemDto = z.infer<typeof goodsReceiptItemSchema>;

export const goodsReceiptSchema = z.object({
  supplierId: z.string(),
  purchaseOrderId: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(goodsReceiptItemSchema).min(1),
});
export type GoodsReceiptDto = z.infer<typeof goodsReceiptSchema>;

export const wasteReasonSchema = z.enum([
  "EXPIRED",
  "SPOILED",
  "DAMAGED",
  "PREP_ERROR",
  "OVER_PRODUCTION",
  "OTHER",
]);
export type WasteReason = z.infer<typeof wasteReasonSchema>;

export const wasteLogSchema = z.object({
  ingredientId: z.string(),
  quantity: z.coerce.number().positive(),
  reason: wasteReasonSchema,
  notes: z.string().optional(),
});
export type WasteLogDto = z.infer<typeof wasteLogSchema>;

// ---------------------------------------------------------------------------
// Procurement depth — purchase requests, supplier quotations, vendor invoices
// ---------------------------------------------------------------------------

export const purchaseRequestStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "CONVERTED",
]);
export type PurchaseRequestStatus = z.infer<typeof purchaseRequestStatusSchema>;

export const purchaseRequestItemSchema = z.object({
  ingredientId: z.string(),
  quantityRequested: z.coerce.number().positive(),
  notes: z.string().optional(),
});
export type PurchaseRequestItemDto = z.infer<typeof purchaseRequestItemSchema>;

export const purchaseRequestSchema = z.object({
  notes: z.string().optional(),
  items: z.array(purchaseRequestItemSchema).min(1),
});
export type PurchaseRequestDto = z.infer<typeof purchaseRequestSchema>;

export const quotationStatusSchema = z.enum([
  "DRAFT",
  "RECEIVED",
  "ACCEPTED",
  "REJECTED",
]);
export type QuotationStatus = z.infer<typeof quotationStatusSchema>;

export const supplierQuotationItemSchema = z.object({
  ingredientId: z.string(),
  quantityQuoted: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
});
export type SupplierQuotationItemDto = z.infer<typeof supplierQuotationItemSchema>;

export const supplierQuotationSchema = z.object({
  supplierId: z.string(),
  validUntil: z.coerce.date().optional(),
  notes: z.string().optional(),
  items: z.array(supplierQuotationItemSchema).min(1),
});
export type SupplierQuotationDto = z.infer<typeof supplierQuotationSchema>;

export const supplierInvoiceStatusSchema = z.enum([
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
]);
export type SupplierInvoiceStatus = z.infer<typeof supplierInvoiceStatusSchema>;

export const supplierInvoiceSchema = z.object({
  supplierId: z.string(),
  purchaseOrderId: z.string().optional(),
  goodsReceiptId: z.string().optional(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  totalAmount: z.coerce.number().positive(),
  notes: z.string().optional(),
});
export type SupplierInvoiceDto = z.infer<typeof supplierInvoiceSchema>;

export const supplierPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethod: paymentMethodSchema,
  reference: z.string().optional(),
});
export type SupplierPaymentDto = z.infer<typeof supplierPaymentSchema>;

export const purchaseReturnSchema = z.object({
  supplierId: z.string().min(1),
  reason: z.string().trim().min(1).max(300),
  items: z
    .array(
      z.object({
        ingredientId: z.string().min(1),
        quantity: z.coerce.number().positive(),
      }),
    )
    .min(1),
});
export type PurchaseReturnDto = z.infer<typeof purchaseReturnSchema>;

export const stockCountLineSchema = z.object({
  ingredientId: z.string().min(1),
  countedQty: z.coerce.number().nonnegative(),
});
export type StockCountLineDto = z.infer<typeof stockCountLineSchema>;

export const stockCountSchema = z.object({
  notes: z.string().optional(),
  lines: z.array(stockCountLineSchema).min(1),
});
export type StockCountDto = z.infer<typeof stockCountSchema>;

export const prepRecipeLineSchema = z.object({
  ingredientId: z.string().min(1),
  quantity: z.coerce.number().positive(),
});
export type PrepRecipeLineDto = z.infer<typeof prepRecipeLineSchema>;

export const prepRecipeSchema = z.object({
  name: z.string().min(1),
  outputIngredientId: z.string().min(1),
  outputQuantity: z.coerce.number().positive(),
  notes: z.string().optional(),
  lines: z.array(prepRecipeLineSchema).min(1),
});
export type PrepRecipeDto = z.infer<typeof prepRecipeSchema>;

export const prepBatchSchema = z.object({
  prepRecipeId: z.string().min(1),
  batchMultiplier: z.coerce.number().positive(),
  quantityProduced: z.coerce.number().positive(),
  notes: z.string().optional(),
});
export type PrepBatchDto = z.infer<typeof prepBatchSchema>;
