import type { Prisma, PrismaClient } from '@prisma/client';
import {
  asBool,
  asNumber,
  BranchSettingKey,
  DEFAULT_BRANCH_SETTINGS,
  DEFAULT_RESTAURANT_SETTINGS,
  RestaurantSettingKey,
  type BranchSettingKeyName,
  type RestaurantSettingKeyName,
} from './setting-keys';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Insert only missing defaults in one round-trip. Per-key upserts against Neon
 * (especially from getOnboarding / get settings on every page load) time out
 * and surface as HTTP 500s.
 */
export async function seedRestaurantSettings(db: Db, restaurantId: string) {
  const existing = await db.restaurantSetting.findMany({
    where: { restaurantId },
    select: { key: true },
  });
  const have = new Set(existing.map((row) => row.key));
  const missing = Object.entries(DEFAULT_RESTAURANT_SETTINGS)
    .filter(([key]) => !have.has(key))
    .map(([key, value]) => ({ restaurantId, key, value }));
  if (missing.length === 0) return;
  await db.restaurantSetting.createMany({ data: missing, skipDuplicates: true });
}

export async function seedBranchSettings(db: Db, branchId: string) {
  const existing = await db.branchSetting.findMany({
    where: { branchId },
    select: { key: true },
  });
  const have = new Set(existing.map((row) => row.key));
  const missing = Object.entries(DEFAULT_BRANCH_SETTINGS)
    .filter(([key]) => !have.has(key))
    .map(([key, value]) => ({ branchId, key, value }));
  if (missing.length === 0) return;
  await db.branchSetting.createMany({ data: missing, skipDuplicates: true });
}

export async function readRestaurantSettingsMap(db: Db, restaurantId: string) {
  const rows = await db.restaurantSetting.findMany({ where: { restaurantId } });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  for (const [key, value] of Object.entries(DEFAULT_RESTAURANT_SETTINGS)) {
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

export async function readBranchSettingsMap(db: Db, branchId: string) {
  const rows = await db.branchSetting.findMany({ where: { branchId } });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  for (const [key, value] of Object.entries(DEFAULT_BRANCH_SETTINGS)) {
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

export async function setRestaurantSetting(
  db: Db,
  restaurantId: string,
  key: RestaurantSettingKeyName,
  value: string,
) {
  await db.restaurantSetting.upsert({
    where: { restaurantId_key: { restaurantId, key } },
    create: { restaurantId, key, value },
    update: { value },
  });
}

export async function setBranchSetting(
  db: Db,
  branchId: string,
  key: BranchSettingKeyName,
  value: string,
) {
  await db.branchSetting.upsert({
    where: { branchId_key: { branchId, key } },
    create: { branchId, key, value },
    update: { value },
  });
}

export function restaurantPaymentPrefs(map: Map<string, string>) {
  const orderRaw = map.get(RestaurantSettingKey.paymentMethodOrder) ?? '';
  const order = orderRaw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const preferred = (
    map.get(RestaurantSettingKey.preferredPaymentMethod) ??
    DEFAULT_RESTAURANT_SETTINGS[RestaurantSettingKey.preferredPaymentMethod]
  ).toUpperCase();
  const cashLabel =
    map.get(RestaurantSettingKey.cashLabel) ??
    DEFAULT_RESTAURANT_SETTINGS[RestaurantSettingKey.cashLabel];
  return { order, preferred, cashLabel };
}

export function restaurantBillPayLinkPrefs(map: Map<string, string>) {
  return {
    billPayLinkEnabled: asBool(
      map.get(RestaurantSettingKey.billPayLinkEnabled),
      DEFAULT_RESTAURANT_SETTINGS[RestaurantSettingKey.billPayLinkEnabled] ===
        'true',
    ),
    billPayLinkWhatsappMessage:
      map.get(RestaurantSettingKey.billPayLinkWhatsappMessage) ??
      DEFAULT_RESTAURANT_SETTINGS[
        RestaurantSettingKey.billPayLinkWhatsappMessage
      ],
  };
}

export function branchOrderingFlags(map: Map<string, string>) {
  return {
    payBeforeKitchenKiosk: asBool(
      map.get(BranchSettingKey.payBeforeKitchenKiosk),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payBeforeKitchenKiosk] === 'true',
    ),
    payBeforeKitchenTakeaway: asBool(
      map.get(BranchSettingKey.payBeforeKitchenTakeaway),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payBeforeKitchenTakeaway] === 'true',
    ),
    guestPaidClaimEnabled: asBool(
      map.get(BranchSettingKey.guestPaidClaimEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestPaidClaimEnabled] === 'true',
    ),
    guestCodRequestEnabled: asBool(
      map.get(BranchSettingKey.guestCodRequestEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestCodRequestEnabled] === 'true',
    ),
    guestWaiterEnabled: asBool(
      map.get(BranchSettingKey.guestWaiterEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestWaiterEnabled] === 'true',
    ),
    guestBillEnabled: asBool(
      map.get(BranchSettingKey.guestBillEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestBillEnabled] === 'true',
    ),
  };
}

export function branchDeliveryTracking(map: Map<string, string>) {
  const latRaw = (map.get(BranchSettingKey.deliveryTrackingLat) ?? '').trim();
  const lngRaw = (map.get(BranchSettingKey.deliveryTrackingLng) ?? '').trim();
  const lat = latRaw === '' ? null : Number(latRaw);
  const lng = lngRaw === '' ? null : Number(lngRaw);
  return {
    deliveryTrackingRadiusKm: asNumber(
      map.get(BranchSettingKey.deliveryTrackingRadiusKm),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.deliveryTrackingRadiusKm]),
    ),
    deliveryTrackingStaleMinutes: asNumber(
      map.get(BranchSettingKey.deliveryTrackingStaleMinutes),
      Number(
        DEFAULT_BRANCH_SETTINGS[BranchSettingKey.deliveryTrackingStaleMinutes],
      ),
    ),
    deliveryTrackingLat:
      lat != null && Number.isFinite(lat) ? lat : null,
    deliveryTrackingLng:
      lng != null && Number.isFinite(lng) ? lng : null,
  };
}

export function branchTeamHrSettings(map: Map<string, string>) {
  return {
    leaveAnnualDays: asNumber(
      map.get(BranchSettingKey.leaveAnnualDays),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.leaveAnnualDays]),
    ),
    leaveSickDays: asNumber(
      map.get(BranchSettingKey.leaveSickDays),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.leaveSickDays]),
    ),
    payrollStatutoryEnabled: asBool(
      map.get(BranchSettingKey.payrollStatutoryEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollStatutoryEnabled] ===
        'true',
    ),
    payrollPfRate: asNumber(
      map.get(BranchSettingKey.payrollPfRate),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollPfRate]),
    ),
    payrollPfWageCeiling: asNumber(
      map.get(BranchSettingKey.payrollPfWageCeiling),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollPfWageCeiling]),
    ),
    payrollEsiGrossLimit: asNumber(
      map.get(BranchSettingKey.payrollEsiGrossLimit),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollEsiGrossLimit]),
    ),
    payrollEsiEmployeeRate: asNumber(
      map.get(BranchSettingKey.payrollEsiEmployeeRate),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollEsiEmployeeRate]),
    ),
    payrollEsiEmployerRate: asNumber(
      map.get(BranchSettingKey.payrollEsiEmployerRate),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.payrollEsiEmployerRate]),
    ),
  };
}

export function branchAccountingSettings(map: Map<string, string>) {
  const raw =
    map.get(BranchSettingKey.expenseCategories) ??
    DEFAULT_BRANCH_SETTINGS[BranchSettingKey.expenseCategories];
  const expenseCategories = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    expenseCategories,
    expenseRequireApproval: asBool(
      map.get(BranchSettingKey.expenseRequireApproval),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.expenseRequireApproval] ===
        'true',
    ),
    cashVarianceWarnAmount: asNumber(
      map.get(BranchSettingKey.cashVarianceWarnAmount),
      Number(DEFAULT_BRANCH_SETTINGS[BranchSettingKey.cashVarianceWarnAmount]),
    ),
    pettyCashInTillClose: asBool(
      map.get(BranchSettingKey.pettyCashInTillClose),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.pettyCashInTillClose] === 'true',
    ),
  };
}
