import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateBranchDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';

const LEADER_ROLES = ['OWNER', 'ADMINISTRATOR'] as const;

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Adds a location to the caller's restaurant. Tax registration is copied
   * from the first branch. The menu can be copied too: dishes, prices,
   * photos, and options. Stock stays at the original location.
   */
  async create(restaurantId: string, userId: string, dto: CreateBranchDto) {
    const name = dto.name.trim();
    const duplicate = await this.prisma.branch.findFirst({
      where: {
        restaurantId,
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        'This restaurant already has a location with that name',
      );
    }

    const source = await this.prisma.branch.findFirst({
      where: { restaurantId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    const leaders = await this.prisma.user.findMany({
      where: {
        restaurantId,
        isActive: true,
        OR: [{ id: userId }, { role: { name: { in: [...LEADER_ROLES] } } }],
      },
      select: { id: true },
    });

    return this.prisma.$transaction(
      async (tx) => {
        const branch = await tx.branch.create({
          data: {
            restaurantId,
            name,
            address: dto.address ?? null,
            phone: dto.phone ?? null,
            country: source?.country ?? 'IN',
            taxRegime: source?.taxRegime ?? 'INDIA_GST',
            taxMode: source?.taxMode ?? 'INCLUSIVE',
            taxLabel: source?.taxLabel,
            taxId: source?.taxId,
            gstNumber: source?.gstNumber,
            autoConfirmOrders: source?.autoConfirmOrders ?? false,
            autoConfirmReservations: source?.autoConfirmReservations ?? false,
          },
        });
        await tx.floor.create({
          data: { branchId: branch.id, name: 'Dining Room', sortOrder: 0 },
        });
        if (leaders.length > 0) {
          await tx.userBranch.createMany({
            data: leaders.map((user) => ({
              userId: user.id,
              branchId: branch.id,
            })),
            skipDuplicates: true,
          });
        }

        const menuItems =
          dto.copyMenu !== false && source
            ? await this.cloneMenu(tx, source.id, branch.id)
            : 0;
        if (dto.copyMenu === false || !source) {
          await tx.kitchenStation.create({
            data: { branchId: branch.id, name: 'Kitchen' },
          });
        }
        return { id: branch.id, name: branch.name, menuItems };
      },
      { timeout: 20_000 },
    );
  }

  /** Copies the sellable menu onto a location that does not have one yet. */
  async copyMenu(
    restaurantId: string,
    targetBranchId: string,
    sourceBranchId?: string,
  ) {
    const target = await this.prisma.branch.findFirst({
      where: { id: targetBranchId, restaurantId, isActive: true },
      select: { id: true, name: true },
    });
    if (!target) throw new NotFoundException('Location not found');

    const source = sourceBranchId
      ? await this.prisma.branch.findFirst({
          where: { id: sourceBranchId, restaurantId, isActive: true },
          select: { id: true },
        })
      : await this.prisma.branch.findFirst({
          where: {
            restaurantId,
            isActive: true,
            id: { not: targetBranchId },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
    if (!source) {
      throw new BadRequestException('There is no other location to copy from');
    }
    if (source.id === target.id) {
      throw new BadRequestException('Choose a different location to copy from');
    }

    const menuItems = await this.prisma.$transaction(
      (tx) => this.cloneMenu(tx, source.id, target.id),
      { timeout: 20_000 },
    );
    return { id: target.id, name: target.name, menuItems };
  }

  private async cloneMenu(
    tx: Prisma.TransactionClient,
    sourceBranchId: string,
    targetBranchId: string,
  ) {
    const already = await tx.menuItem.count({
      where: { branchId: targetBranchId },
    });
    if (already > 0) {
      throw new ConflictException('This location already has a menu');
    }

    const stations = await tx.kitchenStation.findMany({
      where: { branchId: sourceBranchId },
      orderBy: { name: 'asc' },
    });
    const existingStations = await tx.kitchenStation.findMany({
      where: { branchId: targetBranchId },
    });
    const stationByName = new Map(
      existingStations.map((station) => [station.name.toLowerCase(), station.id]),
    );
    const stationMap = new Map<string, string>();
    for (const station of stations) {
      const key = station.name.toLowerCase();
      const existingId = stationByName.get(key);
      if (existingId) {
        stationMap.set(station.id, existingId);
        continue;
      }
      const created = await tx.kitchenStation.create({
        data: {
          branchId: targetBranchId,
          name: station.name,
          printerName: station.printerName,
        },
      });
      stationMap.set(station.id, created.id);
      stationByName.set(key, created.id);
    }
    if (stationByName.size === 0) {
      await tx.kitchenStation.create({
        data: { branchId: targetBranchId, name: 'Kitchen' },
      });
    }

    const categories = await tx.menuCategory.findMany({
      where: { branchId: sourceBranchId },
      orderBy: { sortOrder: 'asc' },
    });
    const categoryMap = new Map<string, string>();
    for (const category of categories) {
      const created = await tx.menuCategory.create({
        data: {
          branchId: targetBranchId,
          name: category.name,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          showOnWebsite: category.showOnWebsite,
        },
      });
      categoryMap.set(category.id, created.id);
    }
    for (const category of categories) {
      if (!category.parentId) continue;
      const id = categoryMap.get(category.id);
      const parentId = categoryMap.get(category.parentId);
      if (id && parentId) {
        await tx.menuCategory.update({ where: { id }, data: { parentId } });
      }
    }

    const groups = await tx.modifierGroup.findMany({
      where: { branchId: sourceBranchId },
      include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
    });
    const groupMap = new Map<string, string>();
    for (const group of groups) {
      const created = await tx.modifierGroup.create({
        data: {
          branchId: targetBranchId,
          name: group.name,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          isRequired: group.isRequired,
          modifiers: {
            create: group.modifiers.map((modifier) => ({
              name: modifier.name,
              priceAdjustment: modifier.priceAdjustment,
              taxRatePercent: modifier.taxRatePercent,
              kitchenNote: modifier.kitchenNote,
              isDefault: modifier.isDefault,
              sortOrder: modifier.sortOrder,
            })),
          },
        },
      });
      groupMap.set(group.id, created.id);
    }

    const items = await tx.menuItem.findMany({
      where: { branchId: sourceBranchId },
      include: {
        modifierGroups: true,
        comboComponents: true,
        sizes: { orderBy: { sortOrder: 'asc' } },
        channelPrices: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
    const itemMap = new Map<string, string>();
    for (const item of items) {
      const categoryId = categoryMap.get(item.categoryId);
      if (!categoryId) continue;
      const created = await tx.menuItem.create({
        data: {
          branchId: targetBranchId,
          categoryId,
          stationId: item.stationId
            ? (stationMap.get(item.stationId) ?? null)
            : null,
          name: item.name,
          sku: item.sku,
          description: item.description,
          imageUrl: item.imageUrl,
          price: item.price,
          taxRatePercent: item.taxRatePercent,
          costPrice: item.costPrice,
          prepTimeMinutes: item.prepTimeMinutes,
          calories: item.calories,
          isVeg: item.isVeg,
          isVegan: item.isVegan,
          isJain: item.isJain,
          isHalal: item.isHalal,
          isGlutenFree: item.isGlutenFree,
          spiceLevel: item.spiceLevel,
          allergens: item.allergens,
          availableFrom: item.availableFrom,
          availableTo: item.availableTo,
          isSeasonal: item.isSeasonal,
          seasonStart: item.seasonStart,
          seasonEnd: item.seasonEnd,
          barcode: item.barcode,
          soldByWeight: item.soldByWeight,
          hsnCode: item.hsnCode,
          isActive: item.isActive,
          isCombo: item.isCombo,
          halfPrice: item.halfPrice,
          sortOrder: item.sortOrder,
          // Recipes point at the original location's stock, so the copy
          // sells the same dishes without sharing that stock.
          inventoryTracking: 'NONE',
          sizes:
            item.sizes.length > 0
              ? {
                  create: item.sizes.map((size) => ({
                    name: size.name,
                    price: size.price,
                    sortOrder: size.sortOrder,
                  })),
                }
              : undefined,
        },
      });
      itemMap.set(item.id, created.id);
    }

    const links = items.flatMap((item) => {
      const menuItemId = itemMap.get(item.id);
      if (!menuItemId) return [];
      return item.modifierGroups.flatMap((link) => {
        const modifierGroupId = groupMap.get(link.modifierGroupId);
        if (!modifierGroupId) return [];
        return [{ menuItemId, modifierGroupId, sortOrder: link.sortOrder }];
      });
    });
    if (links.length > 0) {
      await tx.menuItemModifierGroup.createMany({ data: links });
    }

    for (const item of items) {
      if (!item.isCombo) continue;
      const comboItemId = itemMap.get(item.id);
      if (!comboItemId) continue;
      for (const component of item.comboComponents) {
        const componentItemId = itemMap.get(component.componentItemId);
        if (!componentItemId) continue;
        await tx.comboComponent.create({
          data: {
            comboItemId,
            componentItemId,
            quantity: component.quantity,
          },
        });
      }
    }

    const channels = await tx.salesChannel.findMany({
      where: { branchId: sourceBranchId },
    });
    const channelMap = new Map<string, string>();
    for (const channel of channels) {
      const created = await tx.salesChannel.create({
        data: {
          branchId: targetBranchId,
          name: channel.name,
          orderType: channel.orderType,
          foodPlatform: channel.foodPlatform,
          markupPercent: channel.markupPercent,
          isDefault: channel.isDefault,
          isActive: channel.isActive,
          sortOrder: channel.sortOrder,
        },
      });
      channelMap.set(channel.id, created.id);
    }
    const priceRows = items.flatMap((item) => {
      const menuItemId = itemMap.get(item.id);
      if (!menuItemId) return [];
      return item.channelPrices.flatMap((price) => {
        const channelId = channelMap.get(price.channelId);
        if (!channelId) return [];
        return [{ menuItemId, channelId, price: price.price }];
      });
    });
    if (priceRows.length > 0) {
      await tx.menuItemChannelPrice.createMany({ data: priceRows });
    }

    const sets = await tx.menuSet.findMany({
      where: { branchId: sourceBranchId },
      include: { items: true },
    });
    for (const set of sets) {
      const created = await tx.menuSet.create({
        data: {
          branchId: targetBranchId,
          name: set.name,
          sortOrder: set.sortOrder,
          isActive: set.isActive,
          isForced: set.isForced,
          daysOfWeek: set.daysOfWeek,
          startMinute: set.startMinute,
          endMinute: set.endMinute,
        },
      });
      const setItems = set.items.flatMap((row) => {
        const menuItemId = itemMap.get(row.menuItemId);
        return menuItemId ? [{ menuSetId: created.id, menuItemId }] : [];
      });
      if (setItems.length > 0) {
        await tx.menuSetItem.createMany({ data: setItems });
      }
    }

    return itemMap.size;
  }
}
