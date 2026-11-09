/** Keys stored in restaurant_settings / branch_settings — never hardcode product policy in callers. */

export const RestaurantSettingKey = {
  preferredPaymentMethod: 'preferred_payment_method',
  paymentMethodOrder: 'payment_method_order',
  cashLabel: 'cash_label',
} as const;

export const BranchSettingKey = {
  payBeforeKitchenKiosk: 'pay_before_kitchen_kiosk',
  payBeforeKitchenTakeaway: 'pay_before_kitchen_takeaway',
  guestPaidClaimEnabled: 'guest_paid_claim_enabled',
  guestCodRequestEnabled: 'guest_cod_request_enabled',
  guestWaiterEnabled: 'guest_waiter_enabled',
  guestBillEnabled: 'guest_bill_enabled',
  /** Circular delivery-radius geofence around the branch (km). 0 = off. */
  deliveryTrackingRadiusKm: 'delivery_tracking_radius_km',
  /** Flag open deliveries whose last GPS ping is older than this (minutes). */
  deliveryTrackingStaleMinutes: 'delivery_tracking_stale_minutes',
  deliveryTrackingLat: 'delivery_tracking_lat',
  deliveryTrackingLng: 'delivery_tracking_lng',
  /** Default yearly annual leave days when a staff override is not set. */
  leaveAnnualDays: 'leave_annual_days',
  /** Default yearly sick leave days when a staff override is not set. */
  leaveSickDays: 'leave_sick_days',
  /** When true, India PF/ESI/TDS estimates apply on payroll for this branch. */
  payrollStatutoryEnabled: 'payroll_statutory_enabled',
  payrollPfRate: 'payroll_pf_rate',
  payrollPfWageCeiling: 'payroll_pf_wage_ceiling',
  payrollEsiGrossLimit: 'payroll_esi_gross_limit',
  payrollEsiEmployeeRate: 'payroll_esi_employee_rate',
  payrollEsiEmployerRate: 'payroll_esi_employer_rate',
  /** Comma-separated expense categories for the Accounting picker. */
  expenseCategories: 'expense_categories',
  /** When true, new expenses start PENDING and need approval. */
  expenseRequireApproval: 'expense_require_approval',
  /** Soft-warn when |cash variance| exceeds this amount (0 = never). */
  cashVarianceWarnAmount: 'cash_variance_warn_amount',
  /** When true, net petty-cash OUT for the business date reduces expected till cash. */
  pettyCashInTillClose: 'petty_cash_in_till_close',
} as const;

export type RestaurantSettingKeyName =
  (typeof RestaurantSettingKey)[keyof typeof RestaurantSettingKey];
export type BranchSettingKeyName =
  (typeof BranchSettingKey)[keyof typeof BranchSettingKey];

/** Seeded when a restaurant (or branch) is created — editable later in Settings. */
export const DEFAULT_RESTAURANT_SETTINGS: Record<RestaurantSettingKeyName, string> = {
  [RestaurantSettingKey.preferredPaymentMethod]: 'UPI',
  [RestaurantSettingKey.paymentMethodOrder]: 'UPI,CASH,CARD,OTHER',
  [RestaurantSettingKey.cashLabel]: 'COD',
};

export const DEFAULT_BRANCH_SETTINGS: Record<BranchSettingKeyName, string> = {
  [BranchSettingKey.payBeforeKitchenKiosk]: 'false',
  [BranchSettingKey.payBeforeKitchenTakeaway]: 'false',
  [BranchSettingKey.guestPaidClaimEnabled]: 'false',
  [BranchSettingKey.guestCodRequestEnabled]: 'false',
  [BranchSettingKey.guestWaiterEnabled]: 'true',
  [BranchSettingKey.guestBillEnabled]: 'true',
  [BranchSettingKey.deliveryTrackingRadiusKm]: '5',
  [BranchSettingKey.deliveryTrackingStaleMinutes]: '10',
  [BranchSettingKey.deliveryTrackingLat]: '',
  [BranchSettingKey.deliveryTrackingLng]: '',
  [BranchSettingKey.leaveAnnualDays]: '18',
  [BranchSettingKey.leaveSickDays]: '12',
  [BranchSettingKey.payrollStatutoryEnabled]: 'true',
  [BranchSettingKey.payrollPfRate]: '0.12',
  [BranchSettingKey.payrollPfWageCeiling]: '15000',
  [BranchSettingKey.payrollEsiGrossLimit]: '21000',
  [BranchSettingKey.payrollEsiEmployeeRate]: '0.0075',
  [BranchSettingKey.payrollEsiEmployerRate]: '0.0325',
  [BranchSettingKey.expenseCategories]:
    'Rent,Utilities,Supplies,Maintenance,Transport,Marketing,Misc',
  [BranchSettingKey.expenseRequireApproval]: 'true',
  [BranchSettingKey.cashVarianceWarnAmount]: '100',
  [BranchSettingKey.pettyCashInTillClose]: 'false',
};

export function asNumber(value: string | null | undefined, fallback: number) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asBool(value: string | null | undefined, fallback: boolean) {
  if (value == null || value === '') return fallback;
  return value === 'true' || value === '1';
}
