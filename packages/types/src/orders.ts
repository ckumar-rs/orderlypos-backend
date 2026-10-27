import { z } from "zod";

export const orderTypeSchema = z.enum([
  "DINE_IN",
  "TAKEAWAY",
  "DELIVERY",
  "DRIVE_THRU",
  "QR_ORDER",
  "KIOSK",
  "PHONE",
]);
export type OrderTypeDto = z.infer<typeof orderTypeSchema>;

export const kotStatusSchema = z.enum([
  "NEW",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "SERVED",
  "CANCELLED",
  // Kitchen declined the ticket (distinct from CANCELLED, which is the order
  // being withdrawn from the floor). Set only through the reject endpoint.
  "REJECTED",
]);
export type KotStatusDto = z.infer<typeof kotStatusSchema>;

export const paymentMethodSchema = z.enum([
  "CASH",
  "CARD",
  "UPI",
  "WALLET",
  "BANK_TRANSFER",
  "GIFT_CARD",
  "STORE_CREDIT",
  "OTHER",
]);
export type PaymentMethodDto = z.infer<typeof paymentMethodSchema>;

export const cartItemModifierSchema = z.object({
  modifierId: z.string(),
});

export const cartItemSchema = z.object({
  menuItemId: z.string(),
  quantity: z.number().int().positive(),
  kitchenNote: z.string().optional(),
  modifierIds: z.array(z.string()).default([]),
  // Kilograms, required by the server when the dish is sold by weight.
  weightKg: z.number().positive().max(50).optional(),
  // Staff only. A guest-facing order ignores these.
  guestNumber: z.number().int().min(1).max(20).optional(),
  complimentary: z.boolean().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  // Half / full portion of an item that has a halfPrice. CUSTOM is a
  // staff-typed price + label (never accepted from customer-facing channels).
  portion: z.enum(["HALF", "FULL", "CUSTOM"]).optional(),
  customPrice: z.number().nonnegative().max(1_000_000).optional(),
  customLabel: z.string().trim().max(40).optional(),
  sizeId: z.string().optional(),
});
export type CartItemDto = z.infer<typeof cartItemSchema>;

// --- Delivery (Phase 5) ---------------------------------------------------

export const deliveryStatusSchema = z.enum([
  "UNASSIGNED",
  "ASSIGNED",
  "PICKED_UP",
  "DELIVERED",
  "FAILED",
]);
export type DeliveryStatusDto = z.infer<typeof deliveryStatusSchema>;

export const deliveryInfoSchema = z.object({
  address: z.string().trim().min(5).max(300),
  pincode: z.string().trim().min(3).max(12),
  phone: z.string().trim().min(6).max(20),
});
export type DeliveryInfoDto = z.infer<typeof deliveryInfoSchema>;

export const deliveryZoneSchema = z.object({
  name: z.string().trim().min(1).max(60),
  fee: z.coerce.number().min(0).default(0),
  minOrderAmount: z.coerce.number().min(0).default(0),
  etaMinutes: z.coerce.number().int().min(5).max(240).default(45),
  pincodes: z.array(z.string().trim().min(3).max(12)).min(1),
  isActive: z.boolean().default(true),
});
export type DeliveryZoneDto = z.infer<typeof deliveryZoneSchema>;
export const deliveryZoneUpdateSchema = deliveryZoneSchema.partial();
export type DeliveryZoneUpdateDto = z.infer<typeof deliveryZoneUpdateSchema>;

export const assignDriverSchema = z.object({ driverId: z.string().min(1) });

export const driverLocationSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});
export type DriverLocationDto = z.infer<typeof driverLocationSchema>;
export const deliveryStatusUpdateSchema = z.object({
  status: deliveryStatusSchema,
});

export const createOrderSchema = z.object({
  type: orderTypeSchema.default("DINE_IN"),
  tableId: z.string().optional(),
  guestCount: z.number().int().positive().optional(),
  customerId: z.string().optional(),
  guestName: z.string().trim().min(1).max(60).optional(),
  notes: z.string().optional(),
  // Required when type is DELIVERY (validated against the branch's zones).
  delivery: deliveryInfoSchema.optional(),
  // Scheduled order: ISO time in the future; the kitchen starts then.
  scheduledFor: z.string().datetime().optional(),
  // Staff only: save the order without sending it to the kitchen.
  held: z.boolean().optional(),
  salesChannelId: z.string().optional(),
  // Same id on every retry of one basket, so an offline replay cannot open a second bill.
  clientRequestId: z.string().trim().min(8).max(80).optional(),
  items: z.array(cartItemSchema).min(1),
});
export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export const addOrderItemsSchema = z.object({
  items: z.array(cartItemSchema).min(1),
});
export type AddOrderItemsDto = z.infer<typeof addOrderItemsSchema>;

export const moveItemSchema = z.object({
  orderItemId: z.string().min(1),
  targetOrderId: z.string().min(1),
});
export type MoveItemDto = z.infer<typeof moveItemSchema>;

export const splitTableSchema = z.object({
  targetTableId: z.string().min(1),
  orderItemIds: z.array(z.string().min(1)).min(1).max(50),
});
export type SplitTableDto = z.infer<typeof splitTableSchema>;

export const exchangeItemSchema = z.object({
  orderItemId: z.string().min(1),
  menuItemId: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  weightKg: z.number().positive().max(50).optional(),
});
export type ExchangeItemDto = z.infer<typeof exchangeItemSchema>;

// Guest self-order from a table's QR code — no account, so a name is the
// only way staff can tell whose order this is (shown on KDS/order lists).
export const publicOrderSchema = z.object({
  guestName: z.string().trim().min(1, "Please enter your name").max(60),
  // Kept for every retry of the same basket, including one queued while offline.
  requestId: z.string().trim().min(8).max(80).optional(),
  items: z.array(cartItemSchema).min(1),
});
export type PublicOrderDto = z.infer<typeof publicOrderSchema>;

// Self-service kiosk order. No name or any other personal data is collected.
// requestId is a client-generated idempotency key: the kiosk keeps the same
// one for every retry of the same basket, so a dropped connection can never
// turn into a second order. A cooking note is a short instruction for the
// kitchen, not a place for a phone number or other personal data.
export const kioskServiceTypeSchema = z.enum(["DINE_IN", "TAKEAWAY"]);
export type KioskServiceType = z.infer<typeof kioskServiceTypeSchema>;
export const kioskOrderSchema = z.object({
  requestId: z.string().uuid(),
  serviceType: kioskServiceTypeSchema,
        items: z
    .array(
      z.object({
        menuItemId: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(20),
        modifierIds: z.array(z.string().max(64)).max(30).default([]),
        sizeId: z.string().max(64).optional(),
        kitchenNote: z.string().trim().max(80).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type KioskOrderDto = z.infer<typeof kioskOrderSchema>;

// What a cashier may enter against a bill. Shared by the bill preview and
// checkout so the figures on the printed bill are exactly what is charged.
const billAdjustmentFields = {
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  discountFlat: z.coerce.number().min(0).optional(),
  tipAmount: z.coerce.number().min(0).optional(),
  loyaltyPointsToRedeem: z.coerce.number().int().min(0).optional(),
  couponCode: z.string().trim().min(3).max(24).optional(),
  employeeDiscount: z.boolean().optional(),
};

export const billPreviewSchema = z.object({
  ...billAdjustmentFields,
});
export type BillPreviewDto = z.infer<typeof billPreviewSchema>;

export const checkoutSchema = z.object({
  ...billAdjustmentFields,
  customerId: z.string().optional(),
  giftCardCode: z.string().optional(),
  payments: z
    .array(
      z.object({
        method: paymentMethodSchema,
        // Amount applied to the bill.
        amount: z.coerce.number().positive(),
        // Cash handed over, when more than `amount` (the difference is the
        // change given back). Only meaningful for CASH.
        tendered: z.coerce.number().positive().optional(),
        reference: z.string().optional(),
      }),
    )
    .default([]),
  // Record these payments without closing the bill when they do not cover it
  // (the rest stays as an outstanding balance). Without it, a short payment
  // is rejected, as before.
  allowPartial: z.boolean().optional(),
  // One per checkout attempt; a repeat of the same key is answered with the
  // original result instead of charging again.
  requestId: z.string().min(8).max(64).optional(),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

export const demoReceiptSchema = z.object({
  phone: z.string().trim().min(10).max(15),
});
export type DemoReceiptDto = z.infer<typeof demoReceiptSchema>;

export const demoPlatformStatusSchema = z.object({
  status: z.enum(["ACCEPTED", "PREPARING", "READY", "DELIVERED"]),
});
export type DemoPlatformStatusDto = z.infer<typeof demoPlatformStatusSchema>;

export const refundSchema = z.object({
  amount: z.coerce.number().positive(),
  reason: z.string().optional(),
  method: paymentMethodSchema,
  // Units physically handed back with this refund. Only these are returned to
  // stock; omit for a money-only refund (stock is left as consumed).
  returnedItems: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
      }),
    )
    .max(100)
    .optional(),
});
export type RefundDto = z.infer<typeof refundSchema>;

// Admin-only permanent delete of finished orders; the caller re-enters their
// own password so a left-open session cannot wipe sales history.
export const deleteOrdersSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(200),
  password: z.string().min(1),
});
export type DeleteOrdersDto = z.infer<typeof deleteOrdersSchema>;

export const mergeOrdersSchema = z.object({
  sourceOrderId: z.string(),
});
export type MergeOrdersDto = z.infer<typeof mergeOrdersSchema>;

// Edit an open bill: move it to another table and/or fix header details.
export const updateOrderSchema = z
  .object({
    tableId: z.string().min(1).optional(),
    guestName: z.string().trim().max(80).nullable().optional(),
    guestCount: z.number().int().min(1).max(100).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    customerId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;

// Correct one line of an open bill. Lowering a quantity or removing a line is
// only possible while the kitchen has not started it; adding more goes
// through "add items" so the kitchen gets a fresh ticket.
export const updateOrderItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  reason: z.string().trim().max(200).optional(),
});
export type UpdateOrderItemDto = z.infer<typeof updateOrderItemSchema>;

export const removeOrderItemSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(200),
});
export type RemoveOrderItemDto = z.infer<typeof removeOrderItemSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(200),
  // Required to cancel once the kitchen has started cooking: an explicit
  // acknowledgement that food is already in progress.
  confirmStarted: z.boolean().optional(),
  // Who asked for it: staff by default, or the guest changing their mind.
  source: z.enum(["STAFF", "CUSTOMER"]).optional(),
});
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

// Forward moves only. Declining a ticket goes through rejectKotSchema and
// withdrawing an order through cancelOrderSchema, so neither can be reached by
// sending an arbitrary status here.
export const kotItemStatusUpdateSchema = z.object({
  status: z.enum(["ACCEPTED", "PREPARING", "READY", "SERVED"]),
});

export const kotHoldSchema = z.object({
  held: z.boolean(),
});
export type KotHoldDto = z.infer<typeof kotHoldSchema>;
export type KotItemStatusUpdateDto = z.infer<typeof kotItemStatusUpdateSchema>;

export const rejectKotSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(200),
  // Needed once the kitchen has started cooking the ticket.
  confirmStarted: z.boolean().optional(),
});
export type RejectKotDto = z.infer<typeof rejectKotSchema>;

export const rejectOrderSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(200),
});
export type RejectOrderDto = z.infer<typeof rejectOrderSchema>;


export const publicRequestSchema = z.object({ type: z.enum(["WAITER", "BILL"]) });
export type PublicRequestDto = z.infer<typeof publicRequestSchema>;
