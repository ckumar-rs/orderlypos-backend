import { z } from "zod";

export const reservationStatusSchema = z.enum([
  "RESERVED",
  "CONFIRMED",
  "ARRIVED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);
export type ReservationStatusDto = z.infer<typeof reservationStatusSchema>;

export const createReservationSchema = z.object({
  customerName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  guestCount: z.number().int().positive(),
  reservedAt: z.coerce.date(),
  durationMinutes: z.number().int().positive().default(90),
  tableId: z.string().optional(),
  specialRequests: z.string().optional(),
  deposit: z.coerce.number().nonnegative().optional(),
  depositPaid: z.boolean().optional(),
  depositReference: z.string().trim().max(80).optional().nullable(),
  depositMethod: z.enum(["CASH", "CARD", "UPI", "WALLET", "HOUSE"]).optional(),
  seating: z.enum(["INDOOR", "OUTDOOR"]).optional(),
});
export type CreateReservationDto = z.infer<typeof createReservationSchema>;

export const updateReservationStatusSchema = z.object({
  status: reservationStatusSchema,
});
export type UpdateReservationStatusDto = z.infer<typeof updateReservationStatusSchema>;

export const waitlistStatusSchema = z.enum(["WAITING", "SEATED", "CANCELLED"]);
export type WaitlistStatusDto = z.infer<typeof waitlistStatusSchema>;

export const createWaitlistEntrySchema = z.object({
  customerName: z.string().min(1),
  phone: z.string().optional(),
  partySize: z.number().int().positive(),
  quotedWaitMinutes: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});
export type CreateWaitlistEntryDto = z.infer<typeof createWaitlistEntrySchema>;

export const seatWaitlistEntrySchema = z.object({
  tableId: z.string().optional(),
});

export const reservationDepositSchema = z.object({
  method: z.enum(["CASH", "CARD", "UPI", "WALLET", "HOUSE"]).optional(),
  reference: z.string().trim().max(80).optional(),
});
export type ReservationDepositDto = z.infer<typeof reservationDepositSchema>;
export type SeatWaitlistEntryDto = z.infer<typeof seatWaitlistEntrySchema>;
