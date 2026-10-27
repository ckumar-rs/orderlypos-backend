import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MenuCategoryDto,
  MenuItemDto,
  MenuPriceRuleDto,
  MenuSetDto,
  ModifierGroupDto,
  SalesChannelDto,
} from '@nodedr-restaurant/types';
import { AuditService } from '../../audit/audit.service';
import { localDateKey, localMinuteAndDay } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';
import { toMinutes } from '../marketing/discounts';
import { fromMinutes } from '../marketing/discounts';
import {
  applyPriceRules,
  channelUnitPrice,
  isOnLiveMenu,
  itemIsListed,
  liveMenuFilter,
  scalePrice,
  wouldCreateCycle,
  descendantIds,
} from './menu-rules';

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly time: BranchTimeService,
  ) {}

  // --- Categories ---------------------------------------------------------

  listCategories(branchId: string) {
    return this.prisma.menuCategory.findMany({
      where: { branchId },
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { items: true } } },
    });
  }

  async createCategory(branchId: string, dto: MenuCategoryDto) {
    if (dto.parentId) await this.assertCategoryInBranch(branchId, dto.parentId);
    return this.prisma.menuCategory.create({ data: { ...dto, branchId } });
  }

  async updateCategory(
    branchId: string,
    id: string,
    dto: Partial<MenuCategoryDto>,
  ) {
    await this.assertCategoryInBranch(branchId, id);
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot sit under itself');
      }
      await this.assertCategoryInBranch(branchId, dto.parentId);
      const rows = await this.prisma.menuCategory.findMany({
        where: { branchId },
        select: { id: true, parentId: true },
      });
      if (wouldCreateCycle(rows, id, dto.parentId)) {
        throw new BadRequestException('That parent would create a loop');
      }
    }
    return this.prisma.menuCategory.update({ where: { id }, data: dto });
  }

  async deleteCategory(branchId: string, id: string) {
    await this.assertCategoryInBranch(branchId, id);
    await this.prisma.menuCategory.delete({ where: { id } });
    return { ok: true };
  }

  private async assertCategoryInBranch(branchId: string, id: string) {
    const category = await this.prisma.menuCategory.findFirst({
      where: { id, branchId },
    });
    if (!category) throw new NotFoundException('Category not found');
  }

  // --- Kitchen stations -----------------------------------------------------

  listStations(branchId: string) {
    return this.prisma.kitchenStation.findMany({ where: { branchId } });
  }

  createStation(
    branchId: string,
    name: string,
    printerName?: string,
    role?: string,
  ) {
    return this.prisma.kitchenStation.create({
      data: {
        branchId,
        name,
        printerName,
        role: role === 'EXPO' ? 'EXPO' : 'COOK',
      },
    });
  }

  listCourses(branchId: string) {
    return this.prisma.kitchenCourse.findMany({
      where: { branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  createCourse(
    branchId: string,
    dto: { name: string; sortOrder?: number; holdByDefault?: boolean },
  ) {
    return this.prisma.kitchenCourse.create({
      data: {
        branchId,
        name: dto.name,
        sortOrder: dto.sortOrder ?? 0,
        holdByDefault: Boolean(dto.holdByDefault),
      },
    });
  }

  async deleteCourse(branchId: string, id: string) {
    const course = await this.prisma.kitchenCourse.findFirst({
      where: { id, branchId },
    });
    if (!course) throw new NotFoundException('Kitchen course not found');
    await this.prisma.kitchenCourse.delete({ where: { id } });
    return { ok: true };
  }

  // --- Menu items -----------------------------------------------------------

  async listItems(branchId: string, categoryId?: string) {
    let categoryIds: string[] | undefined;
    if (categoryId) {
      const rows = await this.prisma.menuCategory.findMany({
        where: { branchId },
        select: { id: true, parentId: true },
      });
      categoryIds = [...descendantIds(rows, categoryId)];
    }
    return this.prisma.menuItem.findMany({
      where: {
        branchId,
        ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      },
      orderBy: { sortOrder: 'asc' },
      include: {
        category: true,
        station: true,
        course: true,
        modifierGroups: {
          include: { modifierGroup: { include: { modifiers: true } } },
        },
        sizes: { orderBy: { sortOrder: 'asc' } },
        channelPrices: true,
      },
    });
  }

  async getItem(branchId: string, id: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, branchId },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { modifiers: true } } },
        },
        sizes: { orderBy: { sortOrder: 'asc' } },
        channelPrices: true,
      },
    });
    if (!item) throw new NotFoundException('Menu item not found');
    return item;
  }

  async createItem(branchId: string, dto: MenuItemDto, userId?: string) {
    await this.assertPriceEdit(branchId, userId);
    const { modifierGroupIds, barcode, sizes, ...rest } = dto;
    await this.assertModifierGroupsInBranch(branchId, modifierGroupIds);
    return this.prisma.menuItem.create({
      data: {
        ...rest,
        barcode: barcode?.trim() || null,
        branchId,
        modifierGroups: {
          create: modifierGroupIds.map((modifierGroupId, index) => ({
            modifierGroupId,
            sortOrder: index,
          })),
        },
        sizes: sizes?.length
          ? {
              create: sizes.map((size, index) => ({
                name: size.name,
                price: size.price,
                sortOrder: size.sortOrder ?? index,
              })),
            }
          : undefined,
      },
      include: {
        modifierGroups: { include: { modifierGroup: true } },
        sizes: { orderBy: { sortOrder: 'asc' } },
      },
    });
  }

  async updateItem(
    branchId: string,
    id: string,
    userId: string,
    dto: Partial<MenuItemDto>,
  ) {
    const existing = await this.getItem(branchId, id);
    if (dto.price !== undefined || dto.sizes !== undefined) {
      await this.assertPriceEdit(branchId, userId);
    }
    const { modifierGroupIds, barcode, sizes, ...rest } = dto;
    if (modifierGroupIds) {
      await this.assertModifierGroupsInBranch(branchId, modifierGroupIds);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (modifierGroupIds) {
        await tx.menuItemModifierGroup.deleteMany({
          where: { menuItemId: id },
        });
        await tx.menuItemModifierGroup.createMany({
          data: modifierGroupIds.map((modifierGroupId, index) => ({
            menuItemId: id,
            modifierGroupId,
            sortOrder: index,
          })),
        });
      }
      if (sizes) {
        await tx.menuItemSize.deleteMany({ where: { menuItemId: id } });
        if (sizes.length) {
          await tx.menuItemSize.createMany({
            data: sizes.map((size, index) => ({
              menuItemId: id,
              name: size.name,
              price: size.price,
              sortOrder: size.sortOrder ?? index,
            })),
          });
        }
      }
      return tx.menuItem.update({
        where: { id },
        data: {
          ...rest,
          ...(barcode !== undefined ? { barcode: barcode?.trim() || null } : {}),
        },
      });
    });

    // Price is the single most owner-relevant field here, so it's logged
    // explicitly (before → after) in addition to the raw change set —
    // everything else in `rest` (name, availability, dietary flags, ...)
    // still shows up via `changes`.
    await this.audit.record({
      userId,
      action: 'menu_item.updated',
      entity: 'MenuItem',
      entityId: id,
      metadata: {
        name: updated.name,
        priceBefore: Number(existing.price),
        priceAfter: Number(updated.price),
        changes: rest,
      },
    });

    return updated;
  }

  private async assertModifierGroupsInBranch(
    branchId: string,
    modifierGroupIds: string[],
  ) {
    if (modifierGroupIds.length === 0) return;
    const count = await this.prisma.modifierGroup.count({
      where: { id: { in: modifierGroupIds }, branchId },
    });
    if (count !== new Set(modifierGroupIds).size) {
      throw new BadRequestException(
        'One or more modifier groups are invalid for this branch',
      );
    }
  }

  async deleteItem(branchId: string, id: string) {
    await this.getItem(branchId, id);
    await this.prisma.menuItem.delete({ where: { id } });
    return { ok: true };
  }

  // --- Modifier groups --------------------------------------------------------

  listModifierGroups(branchId: string) {
    return this.prisma.modifierGroup.findMany({
      where: { branchId },
      include: { modifiers: true },
    });
  }

  createModifierGroup(branchId: string, dto: ModifierGroupDto) {
    const { modifiers, ...rest } = dto;
    return this.prisma.modifierGroup.create({
      data: { ...rest, branchId, modifiers: { create: modifiers } },
      include: { modifiers: true },
    });
  }

  async updateModifierGroup(
    branchId: string,
    id: string,
    dto: Partial<ModifierGroupDto>,
  ) {
    await this.assertModifierGroupInBranch(branchId, id);

    const { modifiers, ...rest } = dto;
    return this.prisma.$transaction(async (tx) => {
      if (modifiers) {
        await tx.modifier.deleteMany({ where: { groupId: id } });
        await tx.modifier.createMany({
          data: modifiers.map((m) => ({ ...m, groupId: id })),
        });
      }
      return tx.modifierGroup.update({
        where: { id },
        data: rest,
        include: { modifiers: true },
      });
    });
  }

  async updateModifierImage(branchId: string, id: string, imageUrl: string | null) {
    const modifier = await this.prisma.modifier.findFirst({
      where: { id, group: { branchId } },
    });
    if (!modifier) throw new NotFoundException('Add-on not found');
    return this.prisma.modifier.update({
      where: { id },
      data: { imageUrl },
    });
  }

  async deleteModifierGroup(branchId: string, id: string) {
    await this.assertModifierGroupInBranch(branchId, id);
    await this.prisma.modifierGroup.delete({ where: { id } });
    return { ok: true };
  }

  private async assertModifierGroupInBranch(branchId: string, id: string) {
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id, branchId },
    });
    if (!group) throw new NotFoundException('Modifier group not found');
  }

  // --- Combo meals -----------------------------------------------------------

  async setComboComponents(
    branchId: string,
    comboItemId: string,
    components: { componentItemId: string; quantity: number }[],
  ) {
    await this.getItem(branchId, comboItemId);
    if (components.some((c) => c.componentItemId === comboItemId)) {
      throw new BadRequestException(
        'A combo cannot include itself as a component',
      );
    }
    const componentIds = components.map((c) => c.componentItemId);
    if (componentIds.length > 0) {
      const count = await this.prisma.menuItem.count({
        where: { id: { in: componentIds }, branchId },
      });
      if (count !== new Set(componentIds).size) {
        throw new BadRequestException(
          'One or more combo components are invalid for this branch',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.comboComponent.deleteMany({ where: { comboItemId } });
      if (components.length > 0) {
        await tx.comboComponent.createMany({
          data: components.map((c) => ({ comboItemId, ...c })),
        });
      }
      await tx.menuItem.update({
        where: { id: comboItemId },
        data: { isCombo: components.length > 0 },
      });
      return tx.comboComponent.findMany({
        where: { comboItemId },
        include: {
          componentItem: { select: { id: true, name: true, price: true } },
        },
      });
    });
  }

  async getComboComponents(branchId: string, comboItemId: string) {
    await this.getItem(branchId, comboItemId);
    return this.prisma.comboComponent.findMany({
      where: { comboItemId },
      include: {
        componentItem: { select: { id: true, name: true, price: true } },
      },
    });
  }

  listChannels(branchId: string) {
    return this.prisma.salesChannel.findMany({
      where: { branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createChannel(branchId: string, dto: SalesChannelDto) {
    if (dto.isDefault) {
      await this.prisma.salesChannel.updateMany({
        where: { branchId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return this.prisma.salesChannel.create({
      data: {
        branchId,
        name: dto.name,
        orderType: dto.orderType ?? null,
        foodPlatform: dto.foodPlatform ?? null,
        markupPercent: dto.markupPercent,
        isDefault: dto.isDefault ?? false,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateChannel(
    branchId: string,
    id: string,
    dto: Partial<SalesChannelDto>,
  ) {
    const row = await this.prisma.salesChannel.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Channel not found');
    if (dto.isDefault) {
      await this.prisma.salesChannel.updateMany({
        where: { branchId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return this.prisma.salesChannel.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name } : {}),
        ...(dto.orderType !== undefined ? { orderType: dto.orderType } : {}),
        ...(dto.foodPlatform !== undefined
          ? { foodPlatform: dto.foodPlatform }
          : {}),
        ...(dto.markupPercent != null
          ? { markupPercent: dto.markupPercent }
          : {}),
        ...(dto.isDefault != null ? { isDefault: dto.isDefault } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async deleteChannel(branchId: string, id: string) {
    const row = await this.prisma.salesChannel.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Channel not found');
    await this.prisma.salesChannel.delete({ where: { id } });
    return { ok: true };
  }

  async setItemChannelPrices(
    branchId: string,
    menuItemId: string,
    prices: { channelId: string; price: number }[],
    userId?: string,
  ) {
    await this.assertPriceEdit(branchId, userId);
    await this.getItem(branchId, menuItemId);
    const channelIds = prices.map((row) => row.channelId);
    if (channelIds.length > 0) {
      const count = await this.prisma.salesChannel.count({
        where: { id: { in: channelIds }, branchId },
      });
      if (count !== new Set(channelIds).size) {
        throw new BadRequestException('One or more channels are invalid');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.menuItemChannelPrice.deleteMany({ where: { menuItemId } });
      if (prices.length > 0) {
        await tx.menuItemChannelPrice.createMany({
          data: prices.map((row) => ({
            menuItemId,
            channelId: row.channelId,
            price: row.price,
          })),
        });
      }
    });
    return this.getItem(branchId, menuItemId);
  }

  async listSets(branchId: string) {
    const rows = await this.prisma.menuSet.findMany({
      where: { branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { items: { select: { menuItemId: true } } },
    });
    return rows.map((row) => ({
      ...row,
      startTime: row.startMinute == null ? null : fromMinutes(row.startMinute),
      endTime: row.endMinute == null ? null : fromMinutes(row.endMinute),
      menuItemIds: row.items.map((item) => item.menuItemId),
    }));
  }

  async createSet(branchId: string, dto: MenuSetDto) {
    if (dto.isForced) {
      await this.prisma.menuSet.updateMany({
        where: { branchId, isForced: true },
        data: { isForced: false },
      });
    }
    const created = await this.prisma.menuSet.create({
      data: {
        branchId,
        name: dto.name,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        isForced: dto.isForced ?? false,
        daysOfWeek: dto.daysOfWeek,
        startMinute: dto.startTime ? toMinutes(dto.startTime) : null,
        endMinute: dto.endTime ? toMinutes(dto.endTime) : null,
        startsOn: dto.startsOn || null,
        endsOn: dto.endsOn || null,
      },
    });
    if (dto.menuItemIds) {
      await this.replaceSetItems(branchId, created.id, dto.menuItemIds);
    }
    return (await this.listSets(branchId)).find((row) => row.id === created.id);
  }

  async updateSet(branchId: string, id: string, dto: Partial<MenuSetDto>) {
    const row = await this.prisma.menuSet.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Menu set not found');
    if (dto.isForced) {
      await this.prisma.menuSet.updateMany({
        where: { branchId, isForced: true, id: { not: id } },
        data: { isForced: false },
      });
    }
    await this.prisma.menuSet.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name } : {}),
        ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
        ...(dto.isForced != null ? { isForced: dto.isForced } : {}),
        ...(dto.daysOfWeek != null ? { daysOfWeek: dto.daysOfWeek } : {}),
        ...(dto.startTime !== undefined
          ? { startMinute: dto.startTime ? toMinutes(dto.startTime) : null }
          : {}),
        ...(dto.endTime !== undefined
          ? { endMinute: dto.endTime ? toMinutes(dto.endTime) : null }
          : {}),
        ...(dto.startsOn !== undefined ? { startsOn: dto.startsOn || null } : {}),
        ...(dto.endsOn !== undefined ? { endsOn: dto.endsOn || null } : {}),
      },
    });
    if (dto.menuItemIds) {
      await this.replaceSetItems(branchId, id, dto.menuItemIds);
    }
    return (await this.listSets(branchId)).find((row) => row.id === id);
  }

  async deleteSet(branchId: string, id: string) {
    const row = await this.prisma.menuSet.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Menu set not found');
    await this.prisma.menuSet.delete({ where: { id } });
    return { ok: true };
  }

  private async replaceSetItems(
    branchId: string,
    menuSetId: string,
    menuItemIds: string[],
  ) {
    if (menuItemIds.length > 0) {
      const count = await this.prisma.menuItem.count({
        where: { id: { in: menuItemIds }, branchId },
      });
      if (count !== new Set(menuItemIds).size) {
        throw new BadRequestException('One or more dishes are invalid');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.menuSetItem.deleteMany({ where: { menuSetId } });
      if (menuItemIds.length > 0) {
        await tx.menuSetItem.createMany({
          data: menuItemIds.map((menuItemId) => ({ menuSetId, menuItemId })),
        });
      }
    });
  }

  async resolveSalesChannel(
    branchId: string,
    hint?: {
      channelId?: string | null;
      orderType?: string | null;
      foodPlatform?: string | null;
    },
  ) {
    const rows = await this.prisma.salesChannel.findMany({
      where: { branchId, isActive: true },
      include: { prices: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (rows.length === 0) return null;
    if (hint?.channelId) {
      const named = rows.find((row) => row.id === hint.channelId);
      if (named) return named;
    }
    if (hint?.foodPlatform) {
      const byPlatform = rows.find(
        (row) => row.foodPlatform === hint.foodPlatform,
      );
      if (byPlatform) return byPlatform;
    }
    if (hint?.orderType) {
      const byType = rows.find((row) => row.orderType === hint.orderType);
      if (byType) return byType;
    }
    return rows.find((row) => row.isDefault) ?? null;
  }

  applyChannelToItem<
    T extends {
      id: string;
      price: { toString(): string } | number;
      halfPrice?: { toString(): string } | number | null;
      sizes?: { price: { toString(): string } | number }[];
      channelPrices?: {
        channelId: string;
        price: { toString(): string } | number;
      }[];
    },
  >(
    item: T,
    channel: {
      id: string;
      markupPercent: { toString(): string } | number;
      prices?: {
        menuItemId: string;
        price: { toString(): string } | number;
      }[];
    } | null,
  ): T {
    if (!channel) return item;
    const override =
      item.channelPrices?.find((row) => row.channelId === channel.id)?.price ??
      channel.prices?.find((row) => row.menuItemId === item.id)?.price;
    const base = Number(item.price);
    const next = channelUnitPrice(
      base,
      Number(channel.markupPercent),
      override == null ? null : Number(override),
    );
    return {
      ...item,
      price: next as T['price'],
      halfPrice:
        item.halfPrice == null
          ? item.halfPrice
          : (scalePrice(Number(item.halfPrice), base, next) as T['halfPrice']),
      sizes: item.sizes?.map((size) => ({
        ...size,
        price: scalePrice(Number(size.price), base, next),
      })),
    };
  }

  async liveFilterForBranch(branchId: string, now = new Date()) {
    const sets = await this.prisma.menuSet.findMany({
      where: { branchId },
      include: { items: { select: { menuItemId: true } } },
    });
    const tz = await this.time.tzForBranch(branchId);
    const { day, minute } = localMinuteAndDay(now, tz);
    return liveMenuFilter(
      sets.map((set) => ({
        ...set,
        daysOfWeek: set.daysOfWeek as number[],
      })),
      day,
      minute,
      localDateKey(now, tz),
    );
  }

  private async clock(branchId: string, now = new Date()) {
    const tz = await this.time.tzForBranch(branchId);
    return { tz, ...localMinuteAndDay(now, tz), today: localDateKey(now, tz), now };
  }

  async assertItemsOnLiveMenu(branchId: string, menuItemIds: string[]) {
    const filter = await this.liveFilterForBranch(branchId);
    const { today, minute, tz } = await this.clock(branchId);
    const rows = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, branchId },
      select: {
        id: true,
        isSeasonal: true,
        seasonStart: true,
        seasonEnd: true,
        availableFrom: true,
        availableTo: true,
      },
    });
    const blocked = rows.filter(
      (row) =>
        !isOnLiveMenu(row.id, filter) ||
        !itemIsListed(
          {
            isSeasonal: row.isSeasonal,
            seasonStart: row.seasonStart ? localDateKey(row.seasonStart, tz) : null,
            seasonEnd: row.seasonEnd ? localDateKey(row.seasonEnd, tz) : null,
            availableFrom: row.availableFrom,
            availableTo: row.availableTo,
          },
          today,
          minute,
        ),
    );
    if (blocked.length > 0) {
      throw new BadRequestException(
        'One or more dishes are not on the menu right now',
      );
    }
  }

  async adjustPrices<
    T extends {
      id: string;
      categoryId: string;
      price: { toString(): string } | number;
    },
  >(branchId: string, items: T[], now = new Date()): Promise<T[]> {
    if (items.length === 0) return items;
    const rules = await this.prisma.menuPriceRule.findMany({
      where: { branchId, isActive: true },
    });
    if (rules.length === 0) return items;
    const { day, minute, now: instant } = await this.clock(branchId, now);
    const categories = await this.prisma.menuCategory.findMany({
      where: { branchId },
      select: { id: true, parentId: true },
    });
    const parent = new Map(categories.map((row) => [row.id, row.parentId]));
    const ancestors = (id: string) => {
      const ids = new Set<string>();
      let current: string | null = id;
      while (current && !ids.has(current)) {
        ids.add(current);
        current = parent.get(current) ?? null;
      }
      return ids;
    };
    const ingredientIds = [
      ...new Set(rules.map((rule) => rule.ingredientId).filter((id): id is string => !!id)),
    ];
    const ingredients = ingredientIds.length
      ? await this.prisma.ingredient.findMany({
          where: { id: { in: ingredientIds }, branchId },
          select: { id: true, currentStock: true },
        })
      : [];
    const stockByIngredient = new Map(
      ingredients.map((row) => [row.id, Number(row.currentStock)]),
    );
    const maxHours = Math.max(0, ...rules.map((rule) => rule.demandHours ?? 0));
    const sales = maxHours
      ? await this.prisma.orderItem.findMany({
          where: {
            menuItemId: { in: items.map((item) => item.id) },
            order: {
              branchId,
              status: 'PAID',
              createdAt: { gte: new Date(instant.getTime() - maxHours * 3_600_000) },
            },
          },
          select: {
            menuItemId: true,
            quantity: true,
            order: { select: { createdAt: true } },
          },
        })
      : [];
    const shaped = rules.map((rule) => ({
      isActive: rule.isActive,
      menuItemId: rule.menuItemId,
      categoryId: rule.categoryId,
      percent: Number(rule.percent),
      daysOfWeek: rule.daysOfWeek as number[],
      startMinute: rule.startMinute,
      endMinute: rule.endMinute,
      stockBelow: rule.stockBelow == null ? null : Number(rule.stockBelow),
      ingredientId: rule.ingredientId,
      demandQty: rule.demandQty,
      demandHours: rule.demandHours,
    }));
    return items.map((item) => {
      const soldByHours = new Map<number, number>();
      for (const rule of shaped) {
        if (rule.demandHours == null || soldByHours.has(rule.demandHours)) continue;
        const since = instant.getTime() - rule.demandHours * 3_600_000;
        const sold = sales
          .filter((line) => line.menuItemId === item.id && line.order.createdAt.getTime() >= since)
          .reduce((sum, line) => sum + line.quantity, 0);
        soldByHours.set(rule.demandHours, sold);
      }
      const next = applyPriceRules(Number(item.price), shaped, {
        itemId: item.id,
        categoryId: item.categoryId,
        categoryIds: ancestors(item.categoryId),
        day,
        minute,
        stockByIngredient,
        soldByHours,
      });
      return next === Number(item.price) ? item : { ...item, price: next as T['price'] };
    });
  }

  listPriceRules(branchId: string) {
    return this.prisma.menuPriceRule.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    }).then((rows) =>
      rows.map((row) => ({
        ...row,
        startTime: row.startMinute == null ? null : fromMinutes(row.startMinute),
        endTime: row.endMinute == null ? null : fromMinutes(row.endMinute),
      })),
    );
  }

  async createPriceRule(branchId: string, dto: MenuPriceRuleDto, userId?: string) {
    await this.assertPriceEdit(branchId, userId);
    if (dto.menuItemId) {
      const item = await this.prisma.menuItem.findFirst({
        where: { id: dto.menuItemId, branchId },
        select: { id: true },
      });
      if (!item) throw new BadRequestException('Dish not found');
    }
    if (dto.categoryId) await this.assertCategoryInBranch(branchId, dto.categoryId);
    if (dto.stockBelow != null && !dto.ingredientId) {
      throw new BadRequestException('Choose the ingredient for a stock price');
    }
    if (dto.ingredientId) {
      const ingredient = await this.prisma.ingredient.findFirst({
        where: { id: dto.ingredientId, branchId },
        select: { id: true },
      });
      if (!ingredient) throw new BadRequestException('Ingredient not found');
    }
    return this.prisma.menuPriceRule.create({
      data: {
        branchId,
        name: dto.name,
        menuItemId: dto.menuItemId || null,
        categoryId: dto.categoryId || null,
        ingredientId: dto.ingredientId || null,
        percent: dto.percent,
        daysOfWeek: dto.daysOfWeek,
        startMinute: dto.startTime ? toMinutes(dto.startTime) : null,
        endMinute: dto.endTime ? toMinutes(dto.endTime) : null,
        stockBelow: dto.stockBelow ?? null,
        demandQty: dto.demandQty ?? null,
        demandHours: dto.demandHours ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async setPriceRuleActive(branchId: string, id: string, isActive: boolean, userId?: string) {
    await this.assertPriceEdit(branchId, userId);
    const row = await this.prisma.menuPriceRule.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Price rule not found');
    return this.prisma.menuPriceRule.update({ where: { id }, data: { isActive } });
  }

  async deletePriceRule(branchId: string, id: string, userId?: string) {
    await this.assertPriceEdit(branchId, userId);
    const row = await this.prisma.menuPriceRule.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Price rule not found');
    await this.prisma.menuPriceRule.delete({ where: { id } });
    return { ok: true };
  }

  private async assertPriceEdit(branchId: string, userId?: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { franchisePriceLock: true } } },
    });
    if (!branch?.restaurant.franchisePriceLock) return;
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { role: { select: { name: true } } },
        })
      : null;
    if (user?.role.name === 'OWNER' || user?.role.name === 'ADMINISTRATOR') return;
    throw new ForbiddenException('Head office has locked menu prices for this franchise');
  }

  async filterPublicCategories<
    T extends {
      id: string;
      items: {
        id: string;
        price: { toString(): string } | number;
        halfPrice?: { toString(): string } | number | null;
        sizes?: { price: { toString(): string } | number }[];
        channelPrices?: {
          channelId: string;
          price: { toString(): string } | number;
        }[];
      }[];
    },
  >(
    branchId: string,
    categories: T[],
    channelHint?: {
      orderType?: string | null;
      foodPlatform?: string | null;
    },
  ) {
    const filter = await this.liveFilterForBranch(branchId);
    const { today, minute, tz } = await this.clock(branchId);
    const channel = await this.resolveSalesChannel(branchId, channelHint);
    const listed = categories.map((category) => ({
      ...category,
      items: category.items.filter((item) => {
        const season = item as {
          isSeasonal?: boolean;
          seasonStart?: Date | null;
          seasonEnd?: Date | null;
          availableFrom?: string | null;
          availableTo?: string | null;
        };
        return (
          isOnLiveMenu(item.id, filter) &&
          itemIsListed(
            {
              isSeasonal: season.isSeasonal,
              seasonStart: season.seasonStart ? localDateKey(season.seasonStart, tz) : null,
              seasonEnd: season.seasonEnd ? localDateKey(season.seasonEnd, tz) : null,
              availableFrom: season.availableFrom,
              availableTo: season.availableTo,
            },
            today,
            minute,
          )
        );
      }),
    }));
    const flat = listed.flatMap((category) =>
      category.items.map((item) => ({ ...item, categoryId: category.id })),
    );
    const priced = await this.adjustPrices(branchId, flat);
    const priceById = new Map(priced.map((item) => [item.id, item.price]));
    return listed
      .map((category) => ({
        ...category,
        items: category.items
          .map((item) => ({ ...item, price: priceById.get(item.id) ?? item.price }))
          .map((item) => this.applyChannelToItem(item, channel)),
      }))
      .filter((category) => category.items.length > 0);
  }
}
