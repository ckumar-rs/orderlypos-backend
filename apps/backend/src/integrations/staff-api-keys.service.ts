import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateStaffApiKeyDto,
  RenameApiKeyDto,
  SessionUser,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_PREFIX = 'ordr_staff_';
const MAX_ACTIVE_KEYS_PER_USER = 10;

// Personal access tokens a staff member generates for themselves (Settings
// > API Keys & MCP) so an MCP client (Claude Desktop, etc. — see src/mcp/)
// or any other programmatic client can call the API as them. Same
// tokenHash-lookup pattern as the JWT session: the raw token is shown
// exactly once at creation and never persisted or retrievable again.
@Injectable()
export class StaffApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  private generateToken(): { raw: string; hash: string; lastFour: string } {
    const raw = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    return {
      raw,
      hash: createHash('sha256').update(raw).digest('hex'),
      lastFour: raw.slice(-4),
    };
  }

  async create(actor: SessionUser, dto: CreateStaffApiKeyDto) {
    const activeCount = await this.prisma.staffApiKey.count({
      where: { userId: actor.id, revokedAt: null },
    });
    if (activeCount >= MAX_ACTIVE_KEYS_PER_USER) {
      throw new BadRequestException(
        `You already have ${MAX_ACTIVE_KEYS_PER_USER} active API keys — revoke one before creating another.`,
      );
    }

    const { raw, hash, lastFour } = this.generateToken();
    const key = await this.prisma.staffApiKey.create({
      data: { userId: actor.id, name: dto.name, tokenHash: hash, lastFour },
    });

    // The only point in this key's lifetime the raw token is ever
    // available — every other read returns the masked summary below.
    return {
      id: key.id,
      name: key.name,
      token: raw,
      lastFour: key.lastFour,
      createdAt: key.createdAt,
    };
  }

  async list(actor: SessionUser) {
    const keys = await this.prisma.staffApiKey.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      lastFour: key.lastFour,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
    }));
  }

  async rename(actor: SessionUser, id: string, dto: RenameApiKeyDto) {
    const key = await this.prisma.staffApiKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException('API key not found');
    if (key.userId !== actor.id) {
      throw new ForbiddenException('You can only rename your own API keys');
    }
    if (key.revokedAt) {
      throw new BadRequestException('Revoked API keys cannot be renamed');
    }
    const updated = await this.prisma.staffApiKey.update({
      where: { id },
      data: { name: dto.name },
    });
    return {
      id: updated.id,
      name: updated.name,
      lastFour: updated.lastFour,
      createdAt: updated.createdAt,
      lastUsedAt: updated.lastUsedAt,
      revokedAt: updated.revokedAt,
    };
  }

  async revoke(actor: SessionUser, id: string) {
    const key = await this.prisma.staffApiKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException('API key not found');
    if (key.userId !== actor.id) {
      throw new ForbiddenException('You can only revoke your own API keys');
    }
    if (!key.revokedAt) {
      await this.prisma.staffApiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  }
}
