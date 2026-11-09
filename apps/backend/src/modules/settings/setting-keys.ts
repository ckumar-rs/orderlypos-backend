/** Keys stored in restaurant_settings / branch_settings — never hardcode product policy in callers. */

export const RestaurantSettingKey = {
  preferredPaymentMethod: 'preferred_payment_method',
  paymentMethodOrder: 'payment_method_order',
  cashLabel: 'cash_label',
  /** When true, incomplete owners are gated to /onboarding after sign-in. */
  onboardingEnabled: 'onboarding_enabled',
  /** When true (or skipped), the first-run wizard no longer redirects. */
  onboardingCompleted: 'onboarding_completed',
  /** Current wizard step id (business | branch | floor | menu | guests | done). */
  onboardingStep: 'onboarding_step',
  /** Owner chose Skip — still counts as completed for gating. */
  onboardingSkipped: 'onboarding_skipped',
  /** Wizard step titles — empty means the UI shows a blank until Settings fills them. */
  onboardingLabelBusiness: 'onboarding_label_business',
  onboardingLabelBranch: 'onboarding_label_branch',
  onboardingLabelFloor: 'onboarding_label_floor',
  onboardingLabelMenu: 'onboarding_label_menu',
  onboardingLabelGuests: 'onboarding_label_guests',
  onboardingBodyBusiness: 'onboarding_body_business',
  onboardingBodyBranch: 'onboarding_body_branch',
  onboardingBodyFloor: 'onboarding_body_floor',
  onboardingBodyMenu: 'onboarding_body_menu',
  onboardingBodyGuests: 'onboarding_body_guests',
  /** Prefill values for floor/menu steps — leave empty so owners type real data (no demo catalog). */
  onboardingDefaultFloorName: 'onboarding_default_floor_name',
  onboardingDefaultTableCount: 'onboarding_default_table_count',
  onboardingDefaultTableCapacity: 'onboarding_default_table_capacity',
  onboardingDefaultCategoryName: 'onboarding_default_category_name',
  onboardingDefaultDishName: 'onboarding_default_dish_name',
  onboardingDefaultDishPrice: 'onboarding_default_dish_price',
  onboardingDefaultDishTaxPercent: 'onboarding_default_dish_tax_percent',
  /** When true, till can mint a guest phone pay link for an open bill. */
  billPayLinkEnabled: 'bill_pay_link_enabled',
  /** WhatsApp share text; use {url} and {order} placeholders. */
  billPayLinkWhatsappMessage: 'bill_pay_link_whatsapp_message',
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
  [RestaurantSettingKey.onboardingEnabled]: 'true',
  [RestaurantSettingKey.onboardingCompleted]: 'false',
  [RestaurantSettingKey.onboardingStep]: 'business',
  [RestaurantSettingKey.onboardingSkipped]: 'false',
  [RestaurantSettingKey.onboardingLabelBusiness]: 'Business',
  [RestaurantSettingKey.onboardingLabelBranch]: 'Branch',
  [RestaurantSettingKey.onboardingLabelFloor]: 'Floor',
  [RestaurantSettingKey.onboardingLabelMenu]: 'Menu',
  [RestaurantSettingKey.onboardingLabelGuests]: 'Guests',
  [RestaurantSettingKey.onboardingBodyBusiness]:
    'Currency, timezone, and UPI for the checkout QR.',
  [RestaurantSettingKey.onboardingBodyBranch]:
    'Address, phone, and tax for this outlet.',
  [RestaurantSettingKey.onboardingBodyFloor]:
    'Add a dining area and tables so dine-in works.',
  [RestaurantSettingKey.onboardingBodyMenu]:
    'Add a category and one priced dish so the till can sell.',
  [RestaurantSettingKey.onboardingBodyGuests]:
    'Loyalty earn and redeem rules for phone-first guests.',
  [RestaurantSettingKey.onboardingDefaultFloorName]: '',
  [RestaurantSettingKey.onboardingDefaultTableCount]: '',
  [RestaurantSettingKey.onboardingDefaultTableCapacity]: '',
  [RestaurantSettingKey.onboardingDefaultCategoryName]: '',
  [RestaurantSettingKey.onboardingDefaultDishName]: '',
  [RestaurantSettingKey.onboardingDefaultDishPrice]: '',
  [RestaurantSettingKey.onboardingDefaultDishTaxPercent]: '',
  [RestaurantSettingKey.billPayLinkEnabled]: 'true',
  [RestaurantSettingKey.billPayLinkWhatsappMessage]:
    'Here is your bill for order {order}: {url}',
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
