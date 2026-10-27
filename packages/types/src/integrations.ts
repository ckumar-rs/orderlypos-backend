import { z } from "zod";
import { deliveryInfoSchema } from "./orders";

// Scopes an IntegrationApiKey (see schema.prisma) can hold — what an
// external website's own backend is allowed to do once authenticated with
// that key. Deliberately separate from the staff PermissionKey list
// (permissions.ts): these are not tied to any staff member or role, they
// describe what an external system integration is allowed to do.
export const INTEGRATION_SCOPES = [
  { key: "locations:read", label: "View locations", description: "List active branches and their basic info." },
  { key: "menu:read", label: "View menu", description: "Read a location's menu, categories, and prices." },
  { key: "orders:write", label: "Create orders", description: "Place a new takeaway/delivery order for a location." },
  { key: "orders:read", label: "View order status", description: "Look up an order's current status." },
  {
    key: "reservations:write",
    label: "Book tables",
    description: "Create a new table reservation for a location.",
  },
  {
    key: "reservations:read",
    label: "View reservation status",
    description: "Look up a reservation's current status.",
  },
] as const;

export const integrationScopeSchema = z.enum(
  INTEGRATION_SCOPES.map((s) => s.key) as [string, ...string[]],
);
export type IntegrationScope = z.infer<typeof integrationScopeSchema>;

export const createIntegrationApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  branchId: z.string().optional(),
  scopes: z.array(integrationScopeSchema).min(1),
});
export type CreateIntegrationApiKeyDto = z.infer<typeof createIntegrationApiKeySchema>;

export const createStaffApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateStaffApiKeyDto = z.infer<typeof createStaffApiKeySchema>;

// Public REST API request/response shapes (docs/integrations-api.md is the
// human-readable version of these).

export const integrationOrderItemSchema = z.object({
  menuItemId: z.string(),
  quantity: z.number().int().positive(),
  modifierIds: z.array(z.string()).default([]),
  kitchenNote: z.string().optional(),
});

export const integrationOrderTypeSchema = z.enum(["TAKEAWAY", "DELIVERY"]);

export const createIntegrationOrderSchema = z.object({
  type: integrationOrderTypeSchema.default("TAKEAWAY"),
  customerName: z.string().trim().min(1).max(80),
  customerPhone: z.string().trim().min(1).max(30),
  notes: z.string().optional(),
  // Needed for DELIVERY once the location has delivery zones configured.
  delivery: deliveryInfoSchema.optional(),
  // Pre-order: ISO time at least 10 minutes ahead.
  scheduledFor: z.string().datetime().optional(),
  items: z.array(integrationOrderItemSchema).min(1),
});
export type CreateIntegrationOrderDto = z.infer<typeof createIntegrationOrderSchema>;

export const createIntegrationReservationSchema = z.object({
  customerName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(1).max(30),
  email: z.string().email().optional(),
  guestCount: z.number().int().positive(),
  reservedAt: z.coerce.date(),
  durationMinutes: z.number().int().positive().default(90),
  specialRequests: z.string().optional(),
});
export type CreateIntegrationReservationDto = z.infer<typeof createIntegrationReservationSchema>;
