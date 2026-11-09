import { randomBytes } from 'crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TAX_REGIME_PRESETS,
  type BranchSettingsDto,
  type RestaurantSettingsDto,
} from '@nodedr-restaurant/types';
import { AuditService } from '../../audit/audit.service';
import { sealSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  BranchSettingKey,
  RestaurantSettingKey,
  DEFAULT_RESTAURANT_SETTINGS,
  type BranchSettingKeyName,
} from './setting-keys';
import {
  branchAccountingSettings,
  branchDeliveryTracking,
  branchOrderingFlags,
  branchTeamHrSettings,
  readBranchSettingsMap,
  readRestaurantSettingsMap,
  restaurantPaymentPrefs,
  seedBranchSettings,
  seedRestaurantSettings,
  setBranchSetting,
  setRestaurantSetting,
} from './settings-kv';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }

  private publicRestaurant(
    restaurant: Awaited<ReturnType<PrismaService['restaurant']['findUnique']>> & {
      tallyLedgers?: { sourceKey: string; ledgerName: string }[];
    },
  ) {
    if (!restaurant) return restaurant;
    const {
      smtpPasswordSealed,
      syncHqTokenSealed,
      waCloudAccessTokenSealed,
      bulkWaApiKeySealed,
      bulkWaWebhookSecretSealed,
      smsApiKeySealed,
      smsApiSecretSealed,
      aiTokenSealed,
      weatherApiKeySealed,
      ...safe
    } = restaurant as typeof restaurant & {
      smtpPasswordSealed?: string | null;
      syncHqTokenSealed?: string | null;
      waCloudAccessTokenSealed?: string | null;
      bulkWaApiKeySealed?: string | null;
      bulkWaWebhookSecretSealed?: string | null;
      smsApiKeySealed?: string | null;
      smsApiSecretSealed?: string | null;
      aiTokenSealed?: string | null;
      weatherApiKeySealed?: string | null;
    };
    return {
      ...safe,
      smtpConfigured: Boolean(smtpPasswordSealed && restaurant.smtpHost && restaurant.smtpFrom),
      syncHqTokenConfigured: Boolean(syncHqTokenSealed),
      waCloudTokenConfigured: Boolean(waCloudAccessTokenSealed),
      bulkWaApiKeyConfigured: Boolean(bulkWaApiKeySealed),
      bulkWaWebhookSecretConfigured: Boolean(bulkWaWebhookSecretSealed),
      smsApiKeyConfigured: Boolean(smsApiKeySealed),
      aiTokenConfigured: Boolean(aiTokenSealed),
      weatherApiKeyConfigured: Boolean(weatherApiKeySealed),
    };
  }

  async get(restaurantId: string, branchId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { tallyLedgers: { select: { sourceKey: true, ledgerName: true } } },
    });
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, restaurantId },
    });
    if (!restaurant || !branch) {
      throw new NotFoundException('Restaurant or branch not found');
    }
    await seedRestaurantSettings(this.prisma, restaurantId);
    await seedBranchSettings(this.prisma, branchId);
    const restaurantMap = await readRestaurantSettingsMap(this.prisma, restaurantId);
    const branchMap = await readBranchSettingsMap(this.prisma, branchId);
    const payment = restaurantPaymentPrefs(restaurantMap);
    const ordering = branchOrderingFlags(branchMap);
    const tracking = branchDeliveryTracking(branchMap);
    const teamHr = branchTeamHrSettings(branchMap);
    const accounting = branchAccountingSettings(branchMap);
    return {
      restaurant: {
        ...this.publicRestaurant(restaurant),
        preferredPaymentMethod: payment.preferred || null,
        paymentMethodOrder: payment.order,
        cashLabel: payment.cashLabel,
      },
      branch: {
        ...branch,
        ...ordering,
        ...tracking,
        ...teamHr,
        ...accounting,
      },
    };
  }

  async updateRestaurant(
    restaurantId: string,
    userId: string,
    dto: RestaurantSettingsDto,
  ) {
    const {
      smtpPassword,
      tallyLedgers,
      syncHqToken,
      waCloudAccessToken,
      bulkWaApiKey,
      bulkWaWebhookSecret,
      smsApiKey,
      smsApiSecret,
      aiToken,
      weatherApiKey,
      preferredPaymentMethod,
      paymentMethodOrder,
      cashLabel,
      ...rest
    } = dto;
    if (preferredPaymentMethod !== undefined) {
      await setRestaurantSetting(
        this.prisma,
        restaurantId,
        RestaurantSettingKey.preferredPaymentMethod,
        preferredPaymentMethod,
      );
    }
    if (paymentMethodOrder !== undefined) {
      await setRestaurantSetting(
        this.prisma,
        restaurantId,
        RestaurantSettingKey.paymentMethodOrder,
        paymentMethodOrder.join(','),
      );
    }
    if (cashLabel !== undefined) {
      await setRestaurantSetting(
        this.prisma,
        restaurantId,
        RestaurantSettingKey.cashLabel,
        cashLabel.trim() ||
          DEFAULT_RESTAURANT_SETTINGS[RestaurantSettingKey.cashLabel],
      );
    }
    const data: Record<string, unknown> = { ...rest };
    if (typeof rest.tallyHost === 'string' && !rest.tallyHost.trim()) {
      data.tallyHost = null;
    }
    if (typeof rest.syncHqUrl === 'string' && !rest.syncHqUrl.trim()) {
      data.syncHqUrl = null;
    }
    for (const key of [
      'waCloudBaseUrl',
      'waCloudPhoneNumberId',
      'waCloudTemplateName',
      'waCloudTemplateLang',
      'bulkWaBaseUrl',
      'smsBaseUrl',
      'smsSenderId',
      'smsCountryPrefix',
      'aiBaseUrl',
      'aiModel',
      'weatherBaseUrl',
    ] as const) {
      const value = rest[key];
      if (typeof value === 'string' && !value.trim()) data[key] = null;
    }
    if (smtpPassword) {
      data.smtpPasswordSealed = sealSecret(smtpPassword, this.keyMaterial());
    }
    if (syncHqToken) {
      data.syncHqTokenSealed = sealSecret(syncHqToken, this.keyMaterial());
    }
    if (waCloudAccessToken) {
      data.waCloudAccessTokenSealed = sealSecret(waCloudAccessToken, this.keyMaterial());
    }
    if (bulkWaApiKey) {
      data.bulkWaApiKeySealed = sealSecret(bulkWaApiKey, this.keyMaterial());
    }
    if (bulkWaWebhookSecret) {
      data.bulkWaWebhookSecretSealed = sealSecret(
        bulkWaWebhookSecret,
        this.keyMaterial(),
      );
    }
    if (smsApiKey) {
      data.smsApiKeySealed = sealSecret(smsApiKey, this.keyMaterial());
    }
    if (smsApiSecret) {
      data.smsApiSecretSealed = sealSecret(smsApiSecret, this.keyMaterial());
    }
    if (aiToken) {
      data.aiTokenSealed = sealSecret(aiToken, this.keyMaterial());
    }
    if (weatherApiKey) {
      data.weatherApiKeySealed = sealSecret(weatherApiKey, this.keyMaterial());
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (tallyLedgers) {
        await tx.tallyLedger.deleteMany({ where: { restaurantId } });
        if (tallyLedgers.length) {
          await tx.tallyLedger.createMany({
            data: tallyLedgers.map((row) => ({
              restaurantId,
              sourceKey: row.sourceKey,
              ledgerName: row.ledgerName,
            })),
          });
        }
      }
      return tx.restaurant.update({
        where: { id: restaurantId },
        data,
        include: { tallyLedgers: { select: { sourceKey: true, ledgerName: true } } },
      });
    });
    await this.audit.record({
      userId,
      action: 'settings.restaurant_updated',
      entity: 'Restaurant',
      entityId: restaurantId,
      metadata: { changes: { ...rest, smtpPassword: smtpPassword ? 'set' : undefined } },
    });
    return this.publicRestaurant(updated);
  }

  async updateBranch(branchId: string, userId: string, dto: BranchSettingsDto) {
    const kvWrites: Array<[BranchSettingKeyName, string | undefined]> = [
      [BranchSettingKey.payBeforeKitchenKiosk, boolToSetting(dto.payBeforeKitchenKiosk)],
      [BranchSettingKey.payBeforeKitchenTakeaway, boolToSetting(dto.payBeforeKitchenTakeaway)],
      [BranchSettingKey.guestPaidClaimEnabled, boolToSetting(dto.guestPaidClaimEnabled)],
      [BranchSettingKey.guestCodRequestEnabled, boolToSetting(dto.guestCodRequestEnabled)],
      [BranchSettingKey.guestWaiterEnabled, boolToSetting(dto.guestWaiterEnabled)],
      [BranchSettingKey.guestBillEnabled, boolToSetting(dto.guestBillEnabled)],
      [
        BranchSettingKey.deliveryTrackingRadiusKm,
        dto.deliveryTrackingRadiusKm !== undefined
          ? String(dto.deliveryTrackingRadiusKm)
          : undefined,
      ],
      [
        BranchSettingKey.deliveryTrackingStaleMinutes,
        dto.deliveryTrackingStaleMinutes !== undefined
          ? String(dto.deliveryTrackingStaleMinutes)
          : undefined,
      ],
      [
        BranchSettingKey.deliveryTrackingLat,
        dto.deliveryTrackingLat !== undefined
          ? dto.deliveryTrackingLat == null
            ? ''
            : String(dto.deliveryTrackingLat)
          : undefined,
      ],
      [
        BranchSettingKey.deliveryTrackingLng,
        dto.deliveryTrackingLng !== undefined
          ? dto.deliveryTrackingLng == null
            ? ''
            : String(dto.deliveryTrackingLng)
          : undefined,
      ],
      [
        BranchSettingKey.leaveAnnualDays,
        dto.leaveAnnualDays !== undefined ? String(dto.leaveAnnualDays) : undefined,
      ],
      [
        BranchSettingKey.leaveSickDays,
        dto.leaveSickDays !== undefined ? String(dto.leaveSickDays) : undefined,
      ],
      [
        BranchSettingKey.payrollStatutoryEnabled,
        boolToSetting(dto.payrollStatutoryEnabled),
      ],
      [
        BranchSettingKey.payrollPfRate,
        dto.payrollPfRate !== undefined ? String(dto.payrollPfRate) : undefined,
      ],
      [
        BranchSettingKey.payrollPfWageCeiling,
        dto.payrollPfWageCeiling !== undefined
          ? String(dto.payrollPfWageCeiling)
          : undefined,
      ],
      [
        BranchSettingKey.payrollEsiGrossLimit,
        dto.payrollEsiGrossLimit !== undefined
          ? String(dto.payrollEsiGrossLimit)
          : undefined,
      ],
      [
        BranchSettingKey.payrollEsiEmployeeRate,
        dto.payrollEsiEmployeeRate !== undefined
          ? String(dto.payrollEsiEmployeeRate)
          : undefined,
      ],
      [
        BranchSettingKey.payrollEsiEmployerRate,
        dto.payrollEsiEmployerRate !== undefined
          ? String(dto.payrollEsiEmployerRate)
          : undefined,
      ],
      [
        BranchSettingKey.expenseCategories,
        dto.expenseCategories !== undefined ? dto.expenseCategories : undefined,
      ],
      [
        BranchSettingKey.expenseRequireApproval,
        boolToSetting(dto.expenseRequireApproval),
      ],
      [
        BranchSettingKey.cashVarianceWarnAmount,
        dto.cashVarianceWarnAmount !== undefined
          ? String(dto.cashVarianceWarnAmount)
          : undefined,
      ],
      [
        BranchSettingKey.pettyCashInTillClose,
        boolToSetting(dto.pettyCashInTillClose),
      ],
    ];
    for (const [key, value] of kvWrites) {
      if (value !== undefined) {
        await setBranchSetting(this.prisma, branchId, key, value);
      }
    }
    const {
      payBeforeKitchenKiosk: _a,
      payBeforeKitchenTakeaway: _b,
      guestPaidClaimEnabled: _c,
      guestCodRequestEnabled: _d,
      guestWaiterEnabled: _e,
      guestBillEnabled: _f,
      deliveryTrackingRadiusKm: _g,
      deliveryTrackingStaleMinutes: _h,
      deliveryTrackingLat: _i,
      deliveryTrackingLng: _j,
      leaveAnnualDays: _k,
      leaveSickDays: _l,
      payrollStatutoryEnabled: _m,
      payrollPfRate: _n,
      payrollPfWageCeiling: _o,
      payrollEsiGrossLimit: _p,
      payrollEsiEmployeeRate: _q,
      payrollEsiEmployerRate: _r,
      expenseCategories: _s,
      expenseRequireApproval: _t,
      cashVarianceWarnAmount: _u,
      pettyCashInTillClose: _v,
      ...columnDto
    } = dto;
    void _a;
    void _b;
    void _c;
    void _d;
    void _e;
    void _f;
    void _g;
    void _h;
    void _i;
    void _j;
    void _k;
    void _l;
    void _m;
    void _n;
    void _o;
    void _p;
    void _q;
    void _r;
    void _s;
    void _t;
    void _u;
    void _v;
    if (
      columnDto.kioskDineInEnabled !== undefined ||
      columnDto.kioskTakeawayEnabled !== undefined
    ) {
      const current = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { kioskDineInEnabled: true, kioskTakeawayEnabled: true },
      });
      const dineIn = columnDto.kioskDineInEnabled ?? current?.kioskDineInEnabled;
      const takeaway =
        columnDto.kioskTakeawayEnabled ?? current?.kioskTakeawayEnabled;
      if (!dineIn && !takeaway) {
        throw new BadRequestException(
          'The kiosk needs at least one of dine-in or takeaway',
        );
      }
    }
    if (columnDto.printerConnection === 'NETWORK' || columnDto.printerHost !== undefined) {
      const current = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { printerConnection: true, printerHost: true },
      });
      const connection = columnDto.printerConnection ?? current?.printerConnection;
      const host =
        columnDto.printerHost !== undefined ? columnDto.printerHost : current?.printerHost;
      if (connection === 'NETWORK' && !host) {
        throw new BadRequestException(
          'Enter the printer address (IP or host name) for network printing',
        );
      }
    }
    // Picking a new regime without also stating a mode gets that regime's
    // own default (INDIA_GST/EU_VAT/ES_IVA -> inclusive, US_SALES_TAX ->
    // exclusive) — a picker that silently kept the old mode across a
    // regime switch would quietly mis-price every item on that branch.
    const data =
      columnDto.taxRegime && columnDto.taxMode === undefined
        ? { ...columnDto, taxMode: TAX_REGIME_PRESETS[columnDto.taxRegime].defaultMode }
        : columnDto;
    const updated = await this.prisma.branch.update({
      where: { id: branchId },
      data,
    });
    await this.audit.record({
      userId,
      action: 'settings.branch_updated',
      entity: 'Branch',
      entityId: branchId,
      metadata: { changes: dto },
    });
    const branchMap = await readBranchSettingsMap(this.prisma, branchId);
    return {
      ...updated,
      ...branchOrderingFlags(branchMap),
      ...branchDeliveryTracking(branchMap),
      ...branchTeamHrSettings(branchMap),
      ...branchAccountingSettings(branchMap),
    };
  }

  /**
   * Kiosk URL credential. 'enable' keeps an existing token (idempotent),
   * 'rotate' replaces it (the old URL stops working immediately — use when a
   * kiosk is lost or the link leaked), 'disable' removes it entirely.
   */
  async setKioskToken(
    branchId: string,
    userId: string,
    action: 'enable' | 'rotate' | 'disable',
  ) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { kioskToken: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const kioskToken =
      action === 'disable'
        ? null
        : action === 'enable' && branch.kioskToken
          ? branch.kioskToken
          : randomBytes(16).toString('hex');
    await this.prisma.branch.update({
      where: { id: branchId },
      data: { kioskToken },
    });
    await this.audit.record({
      userId,
      action: `settings.kiosk_${action}`,
      entity: 'Branch',
      entityId: branchId,
      // Never log the token itself.
      metadata: { enabled: kioskToken !== null },
    });
    return { kioskToken };
  }

  async setPickupDisplayToken(
    branchId: string,
    userId: string,
    action: 'enable' | 'rotate' | 'disable',
  ) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { pickupDisplayToken: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const pickupDisplayToken =
      action === 'disable'
        ? null
        : action === 'enable' && branch.pickupDisplayToken
          ? branch.pickupDisplayToken
          : randomBytes(16).toString('hex');
    await this.prisma.branch.update({
      where: { id: branchId },
      data: { pickupDisplayToken },
    });
    await this.audit.record({
      userId,
      action: `settings.pickup_${action}`,
      entity: 'Branch',
      entityId: branchId,
      metadata: { enabled: pickupDisplayToken !== null },
    });
    return { pickupDisplayToken };
  }

  async sendTestEmail(restaurantId: string, userId: string, to?: string) {
    const recipient = (to ?? '').trim().toLowerCase();
    if (!recipient || !recipient.includes('@')) {
      throw new BadRequestException('Enter a valid email address to receive the test message');
    }
    try {
      const result = await this.email.sendTest(recipient, restaurantId);
      await this.audit.record({
        userId,
        action: 'settings.email_test',
        entity: 'Restaurant',
        entityId: restaurantId,
        metadata: { to: recipient, provider: result.provider },
      });
      return result;
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Could not send the test email',
      );
    }
  }
}

function boolToSetting(value: boolean | undefined) {
  if (value === undefined) return undefined;
  return value ? 'true' : 'false';
}
