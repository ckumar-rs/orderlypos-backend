import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DocumentDto,
  EquipmentDto,
  ServiceLogDto,
} from '@nodedr-restaurant/types';
import { addDaysToDate, localDate } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** Next service date for equipment with a service interval, else null. */
export function nextDue(
  lastServiced: string | null,
  intervalDays: number | null | undefined,
): string | null {
  if (!lastServiced || !intervalDays) return null;
  return addDaysToDate(lastServiced, intervalDays);
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
  ) {}

  // --- Equipment -----------------------------------------------------------

  async listEquipment(branchId: string) {
    const [rows, tz] = await Promise.all([
      this.prisma.equipment.findMany({
        where: { branchId, isActive: true },
        orderBy: [
          { nextDueAt: { sort: 'asc', nulls: 'last' } },
          { name: 'asc' },
        ],
      }),
      this.time.tzForBranch(branchId),
    ]);
    const today = localDate(new Date(), tz);
    return rows.map((e) => {
      const due = e.nextDueAt?.toISOString().slice(0, 10) ?? null;
      return {
        ...e,
        overdue: due != null && due < today,
        dueSoon: due != null && due >= today && due <= addDaysToDate(today, 7),
      };
    });
  }

  createEquipment(branchId: string, dto: EquipmentDto) {
    const due = nextDue(dto.lastServicedAt ?? null, dto.serviceIntervalDays);
    return this.prisma.equipment.create({
      data: {
        branchId,
        name: dto.name,
        location: dto.location,
        serviceIntervalDays: dto.serviceIntervalDays,
        lastServicedAt: dto.lastServicedAt ? asDate(dto.lastServicedAt) : null,
        nextDueAt: due ? asDate(due) : null,
        notes: dto.notes,
      },
    });
  }

  async retireEquipment(branchId: string, id: string) {
    await this.getEquipment(branchId, id);
    await this.prisma.equipment.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  /** Records a service and pushes the next due date forward by the interval. */
  async logService(branchId: string, id: string, dto: ServiceLogDto) {
    const eq = await this.getEquipment(branchId, id);
    const due = nextDue(dto.servicedAt, eq.serviceIntervalDays);
    const [log] = await this.prisma.$transaction([
      this.prisma.serviceLog.create({
        data: {
          equipmentId: id,
          servicedAt: asDate(dto.servicedAt),
          cost: dto.cost,
          note: dto.note,
        },
      }),
      this.prisma.equipment.update({
        where: { id },
        data: {
          // Never move "last serviced" backwards when logging an old visit.
          ...(!eq.lastServicedAt || asDate(dto.servicedAt) >= eq.lastServicedAt
            ? {
                lastServicedAt: asDate(dto.servicedAt),
                nextDueAt: due ? asDate(due) : null,
              }
            : {}),
        },
      }),
    ]);
    return log;
  }

  async listLogs(branchId: string, id: string) {
    await this.getEquipment(branchId, id);
    return this.prisma.serviceLog.findMany({
      where: { equipmentId: id },
      orderBy: { servicedAt: 'desc' },
      take: 100,
    });
  }

  private async getEquipment(branchId: string, id: string) {
    const eq = await this.prisma.equipment.findFirst({
      where: { id, branchId },
    });
    if (!eq) throw new NotFoundException('Equipment not found');
    return eq;
  }

  // --- Documents -----------------------------------------------------------

  listDocuments(branchId: string, category?: string) {
    return this.prisma.document.findMany({
      where: {
        branchId,
        ...(category &&
        ['SOP', 'CONTRACT', 'RECIPE', 'PURCHASE', 'OTHER'].includes(category)
          ? { category: category as DocumentDto['category'] }
          : {}),
      },
      select: { id: true, title: true, category: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async getDocument(branchId: string, id: string) {
    const d = await this.prisma.document.findFirst({
      where: { id, branchId },
      include: {
        files: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  async addDocumentFile(
    branchId: string,
    id: string,
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ) {
    await this.getDocument(branchId, id);
    if (!ATTACHMENT_TYPES.has(file.mimetype))
      throw new BadRequestException(
        'Attach a PDF, image, text, Word or Excel file',
      );
    const count = await this.prisma.documentFile.count({
      where: { documentId: id },
    });
    if (count >= 10)
      throw new BadRequestException('A document can hold at most 10 files');
    const created = await this.prisma.documentFile.create({
      data: {
        documentId: id,
        // Strip path separators and control characters from the client name.
        fileName:
          file.originalname
            // eslint-disable-next-line no-control-regex -- control characters are exactly what is being stripped
            .replace(/[\\/\u0000-\u001f"]/g, '_')
            .slice(0, 150) || 'file',
        mimeType: file.mimetype,
        size: file.size,
        data: new Uint8Array(file.buffer),
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        size: true,
        createdAt: true,
      },
    });
    return created;
  }

  async getDocumentFile(branchId: string, id: string, fileId: string) {
    await this.getDocument(branchId, id);
    const f = await this.prisma.documentFile.findFirst({
      where: { id: fileId, documentId: id },
    });
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  async deleteDocumentFile(branchId: string, id: string, fileId: string) {
    await this.getDocumentFile(branchId, id, fileId);
    await this.prisma.documentFile.delete({ where: { id: fileId } });
    return { ok: true };
  }

  createDocument(branchId: string, dto: DocumentDto) {
    return this.prisma.document.create({ data: { branchId, ...dto } });
  }

  async updateDocument(
    branchId: string,
    id: string,
    dto: Partial<DocumentDto>,
  ) {
    await this.getDocument(branchId, id);
    return this.prisma.document.update({ where: { id }, data: dto });
  }

  async deleteDocument(branchId: string, id: string) {
    await this.getDocument(branchId, id);
    await this.prisma.document.delete({ where: { id } });
    return { ok: true };
  }
}
