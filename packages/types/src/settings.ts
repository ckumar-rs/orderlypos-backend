import { z } from "zod";

// The restaurant's brand name renders in the app shell's top-of-sidebar
// header (fixed-width column, next to the logo) — a name much past this
// starts wrapping/truncating there, so the settings form enforces the same
// limit the layout was built around rather than letting it overflow.
export const RESTAURANT_NAME_MAX_LENGTH = 40;

export const restaurantSettingsSchema = z.object({
  name: z.string().min(1).max(RESTAURANT_NAME_MAX_LENGTH).optional(),
  legalName: z.string().optional(),
  // Shown in place of the product logo in the app shell header and on the
  // login screen once set. Square, ~256x256px+ PNG/SVG with a transparent
  // background reads best in that slot — see the settings page hint text.
  logoUrl: z.string().max(2048).optional().nullable(),
  currency: z.string().optional(),
  timezone: z.string().optional(),
  // UPI id such as "name@okbank" (VPA format per NPCI: handle@psp).
  upiVpa: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/, "Enter a valid UPI id like name@bank")
    .optional()
    .nullable(),
  upiPayeeName: z.string().trim().max(60).optional().nullable(),
  demoMode: z.boolean().optional(),
  loyaltyPointValue: z.coerce.number().min(0).optional(),
  loyaltyEarnPerCurrency: z.coerce.number().int().positive().optional(),
  referralPoints: z.coerce.number().int().min(0).max(100_000).optional(),
  birthdayDiscountPercent: z.coerce.number().min(0).max(100).optional(),
  fssaiNumber: z.string().trim().max(20).optional().nullable(),
  receiptEmail: z.string().trim().email().max(120).optional().nullable(),
  smtpHost: z.string().trim().max(253).optional().nullable(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  smtpUser: z.string().trim().max(120).optional().nullable(),
  smtpPassword: z.string().max(200).optional().nullable(),
  smtpFrom: z.string().trim().email().max(120).optional().nullable(),
  smtpSecure: z.boolean().optional(),
  tallyEnabled: z.boolean().optional(),
  tallyCompanyName: z.string().trim().max(120).optional().nullable(),
  tallyHost: z
    .string()
    .trim()
    .max(253)
    .regex(/^[A-Za-z0-9.-]*$/, "Use an IP address or host name")
    .optional()
    .nullable(),
  tallyPort: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  tallyUseHttps: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
  syncHqUrl: z.string().trim().max(500).optional().nullable(),
  syncHqToken: z.string().max(200).optional().nullable(),
  syncIntervalSec: z.coerce.number().int().min(15).max(3600).optional(),
  tallyLedgers: z
    .array(
      z.object({
        sourceKey: z.string().trim().min(1).max(40),
        ledgerName: z.string().trim().min(1).max(80),
      }),
    )
    .optional(),
  payCash: z.boolean().optional(),
  payCard: z.boolean().optional(),
  payUpi: z.boolean().optional(),
  payOther: z.boolean().optional(),
  receiptWhatsApp: z.boolean().optional(),
  receiptEmailEnabled: z.boolean().optional(),
  receiptPrint: z.boolean().optional(),
  employeeDiscountPercent: z.coerce.number().min(0).max(100).optional(),
  reservationMessage: z.string().trim().max(600).optional().nullable(),
  waCloudEnabled: z.boolean().optional(),
  waCloudBaseUrl: z.string().trim().max(300).optional().nullable(),
  waCloudPhoneNumberId: z.string().trim().max(80).optional().nullable(),
  waCloudAccessToken: z.string().max(400).optional().nullable(),
  waCloudTemplateName: z.string().trim().max(80).optional().nullable(),
  waCloudTemplateLang: z.string().trim().max(12).optional().nullable(),
  smsEnabled: z.boolean().optional(),
  smsProvider: z.enum(["MSG91", "TWILIO", "CUSTOM"]).optional().nullable(),
  smsBaseUrl: z.string().trim().max(300).optional().nullable(),
  smsApiKey: z.string().max(200).optional().nullable(),
  smsApiSecret: z.string().max(200).optional().nullable(),
  smsSenderId: z.string().trim().max(20).optional().nullable(),
  smsCountryPrefix: z.string().trim().max(6).optional().nullable(),
  clvHorizonMonths: z.coerce.number().int().min(1).max(120).optional(),
  clvMarginPercent: z.coerce.number().min(0).max(100).optional(),
  aiEnabled: z.boolean().optional(),
  aiProvider: z.enum(["HUGGINGFACE", "NVIDIA"]).optional().nullable(),
  aiBaseUrl: z.string().trim().max(300).optional().nullable(),
  aiModel: z.string().trim().max(200).optional().nullable(),
  aiToken: z.string().max(400).optional().nullable(),
  aiHistoryDays: z.coerce.number().int().min(7).max(365).optional(),
  aiHorizonDays: z.coerce.number().int().min(1).max(60).optional(),
  aiLeadTimeDays: z.coerce.number().int().min(0).max(90).optional().nullable(),
  weatherBaseUrl: z.string().trim().max(500).optional().nullable(),
  weatherApiKey: z.string().max(200).optional().nullable(),
});
export type RestaurantSettingsDto = z.infer<typeof restaurantSettingsSchema>;

import { TAX_MODES, TAX_REGIMES } from "./tax";

export const branchSettingsSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  gstNumber: z.string().optional(),
  gstStateCode: z.string().trim().max(2).optional().nullable(),
  serviceChargePercent: z.coerce.number().min(0).max(100).optional(),
  // Multi-region tax config — see tax.ts for the regime presets this
  // pairs with (label, default mode, CGST/SGST split).
  country: z.string().length(2).optional(),
  taxRegime: z.enum(TAX_REGIMES).optional(),
  taxMode: z.enum(TAX_MODES).optional(),
  taxLabel: z.string().max(30).optional().nullable(),
  taxId: z.string().max(50).optional().nullable(),
  // Online order / table-booking handling (false = staff accept manually).
  autoConfirmOrders: z.boolean().optional(),
  autoConfirmReservations: z.boolean().optional(),
  // Self-service kiosk: which service-mode buttons the start screen offers.
  kioskDineInEnabled: z.boolean().optional(),
  kioskTakeawayEnabled: z.boolean().optional(),
  // Thermal printer (direct ESC/POS): paper, code page and column override.
  printerPaperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  printerCodepage: z.enum(["CP437", "CP850", "CP858", "CP1252"]).optional(),
  printerColumns: z.number().int().min(20).max(64).nullable().optional(),
  // How the server reaches the thermal printer: USB attached to the server,
  // or a network printer (raw ESC/POS over TCP, normally port 9100).
  printerConnection: z.enum(["USB", "NETWORK"]).optional(),
  printerHost: z
    .string()
    .trim()
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, "Use an IP address or host name")
    .nullable()
    .optional(),
  printerPort: z.number().int().min(1).max(65535).optional(),
});
export type BranchSettingsDto = z.infer<typeof branchSettingsSchema>;

export const createBranchSchema = z.object({
  name: z.string().trim().min(1, "Enter a location name").max(80),
  address: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((value) => value || undefined),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((value) => value || undefined),
  copyMenu: z.boolean().optional().default(true),
});
export type CreateBranchDto = z.infer<typeof createBranchSchema>;

export const copyBranchMenuSchema = z.preprocess(
  (value) => (value == null ? {} : value),
  z.object({
    sourceBranchId: z.string().trim().min(1).optional(),
  }),
);
export type CopyBranchMenuDto = z.infer<typeof copyBranchMenuSchema>;
