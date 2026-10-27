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

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
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
      smsApiKeySealed,
      smsApiSecretSealed,
      aiTokenSealed,
      weatherApiKeySealed,
      ...safe
    } = restaurant as typeof restaurant & {
      smtpPasswordSealed?: string | null;
      syncHqTokenSealed?: string | null;
      waCloudAccessTokenSealed?: string | null;
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
    return { restaurant: this.publicRestaurant(restaurant), branch };
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
      smsApiKey,
      smsApiSecret,
      aiToken,
      weatherApiKey,
      ...rest
    } = dto;
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
    if (
      dto.kioskDineInEnabled !== undefined ||
      dto.kioskTakeawayEnabled !== undefined
    ) {
      const current = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { kioskDineInEnabled: true, kioskTakeawayEnabled: true },
      });
      const dineIn = dto.kioskDineInEnabled ?? current?.kioskDineInEnabled;
      const takeaway =
        dto.kioskTakeawayEnabled ?? current?.kioskTakeawayEnabled;
      if (!dineIn && !takeaway) {
        throw new BadRequestException(
          'The kiosk needs at least one of dine-in or takeaway',
        );
      }
    }
    if (dto.printerConnection === 'NETWORK' || dto.printerHost !== undefined) {
      const current = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { printerConnection: true, printerHost: true },
      });
      const connection = dto.printerConnection ?? current?.printerConnection;
      const host =
        dto.printerHost !== undefined ? dto.printerHost : current?.printerHost;
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
      dto.taxRegime && dto.taxMode === undefined
        ? { ...dto, taxMode: TAX_REGIME_PRESETS[dto.taxRegime].defaultMode }
        : dto;
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
    return updated;
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
}
