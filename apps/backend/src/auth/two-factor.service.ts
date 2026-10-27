import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { isSqlite, stringList } from '../common/sqlite';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateRecoveryCode,
  generateSecret,
  openSecret,
  otpauthUrl,
  sealSecret,
  verifyTotp,
} from './totp';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 8;

interface TwoFactorUser {
  id: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorRecoveryHashes: string[];
  twoFactorLastStep: number | null;
}

@Injectable()
export class TwoFactorService {
  // Per-user failed-attempt counter (single backend instance). A 6-digit code
  // has only a million values, so guessing must be rate-limited per account,
  // not just per IP.
  private readonly failures = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private get keyMaterial() {
    return (
      this.config.get<string>('TWO_FACTOR_KEY') ??
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  private assertNotLocked(userId: string) {
    const f = this.failures.get(userId);
    if (f && f.count >= MAX_FAILURES && Date.now() < f.until)
      throw new UnauthorizedException(
        'Too many incorrect codes. Try again in 15 minutes.',
      );
  }

  private fail(userId: string): never {
    const f = this.failures.get(userId);
    const fresh = !f || Date.now() >= f.until;
    this.failures.set(userId, {
      count: fresh ? 1 : f.count + 1,
      until: Date.now() + LOCK_MS,
    });
    throw new UnauthorizedException('Invalid verification code');
  }

  /**
   * Second factor at login: a current authenticator code, or one unused
   * recovery code (consumed on use). Throws if missing or wrong.
   */
  async verifyLogin(user: TwoFactorUser, code: string | undefined) {
    if (!code) throw new UnauthorizedException('TWO_FACTOR_REQUIRED');
    this.assertNotLocked(user.id);
    const trimmed = code.trim();

    if (/^\d{6}$/.test(trimmed) && user.twoFactorSecret) {
      // If the stored secret can no longer be opened (the signing key was
      // changed), treat the code as wrong rather than erroring — recovery
      // codes are hashed separately and still work.
      let plain: string | null = null;
      try {
        plain = openSecret(user.twoFactorSecret, this.keyMaterial);
      } catch {
        plain = null;
      }
      const step = plain ? verifyTotp(plain, trimmed) : null;
      if (step != null && step > (user.twoFactorLastStep ?? 0)) {
        // Atomic: only the request that advances the step wins, so a
        // replayed or concurrently-reused code is rejected.
        const { count } = await this.prisma.user.updateMany({
          where: {
            id: user.id,
            OR: [
              { twoFactorLastStep: null },
              { twoFactorLastStep: { lt: step } },
            ],
          },
          data: { twoFactorLastStep: step },
        });
        if (count === 1) {
          this.failures.delete(user.id);
          return;
        }
      }
      this.fail(user.id);
    }

    if (await this.consumeRecoveryCode(user, trimmed)) {
      this.failures.delete(user.id);
      return;
    }
    this.fail(user.id);
  }

  private async consumeRecoveryCode(user: TwoFactorUser, input: string) {
    const normalised = input.toUpperCase().replace(/[\s-]/g, '');
    const hashes = stringList(user.twoFactorRecoveryHashes);
    for (const hash of hashes) {
      if (await bcrypt.compare(normalised, hash)) {
        if (isSqlite()) {
          const next = hashes.filter((h) => h !== hash);
          await this.prisma.user.update({
            where: { id: user.id },
            data: { twoFactorRecoveryHashes: next },
          });
          return true;
        }
        const { count } = await this.prisma.user.updateMany({
          where: { id: user.id, twoFactorRecoveryHashes: { has: hash } },
          data: {
            twoFactorRecoveryHashes: user.twoFactorRecoveryHashes.filter(
              (h) => h !== hash,
            ),
          },
        });
        return count === 1;
      }
    }
    return false;
  }

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorRecoveryHashes: true },
    });
    return {
      enabled: u.twoFactorEnabled,
      recoveryCodesLeft: u.twoFactorRecoveryHashes.length,
    };
  }

  /** Starts enrolment: stores a pending secret; not active until confirmed. */
  async setup(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        twoFactorEnabled: true,
        restaurant: { select: { name: true } },
      },
    });
    if (u.twoFactorEnabled)
      throw new BadRequestException('Two-factor authentication is already on');
    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: sealSecret(secret, this.keyMaterial) },
    });
    return {
      secret,
      otpauthUrl: otpauthUrl(secret, u.email ?? u.name, u.restaurant.name),
    };
  }

  /** Confirms enrolment with a first valid code; returns recovery codes once. */
  async enable(userId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (u.twoFactorEnabled)
      throw new BadRequestException('Two-factor authentication is already on');
    if (!u.twoFactorSecret) throw new BadRequestException('Start setup first');
    this.assertNotLocked(userId);
    const step = verifyTotp(
      openSecret(u.twoFactorSecret, this.keyMaterial),
      code,
    );
    if (step == null) this.fail(userId);

    const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode);
    const hashes = await Promise.all(
      codes.map((c) => bcrypt.hash(c.replace(/-/g, ''), 10)),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorLastStep: step,
        twoFactorRecoveryHashes: hashes,
      },
    });
    this.failures.delete(userId);
    await this.audit.record({
      userId,
      action: '2fa.enabled',
      entity: 'User',
      entityId: userId,
    });
    return { recoveryCodes: codes };
  }

  /** Turning it off needs the password AND a valid code (or recovery code). */
  async disable(userId: string, password: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!u.twoFactorEnabled)
      throw new BadRequestException('Two-factor authentication is not on');
    if (!(await bcrypt.compare(password, u.passwordHash)))
      throw new UnauthorizedException('Incorrect password');
    await this.verifyLogin(u, code);
    await this.clear(userId);
    await this.audit.record({
      userId,
      action: '2fa.disabled',
      entity: 'User',
      entityId: userId,
    });
    return { ok: true };
  }

  /** Lets an owner/admin unlock a staff member who lost their device. */
  async adminReset(
    actorId: string,
    restaurantId: string,
    targetUserId: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, restaurantId },
      select: { id: true },
    });
    if (!target) throw new BadRequestException('Staff member not found');
    await this.clear(targetUserId);
    await this.audit.record({
      userId: actorId,
      action: '2fa.reset',
      entity: 'User',
      entityId: targetUserId,
    });
    return { ok: true };
  }

  private async clear(userId: string) {
    this.failures.delete(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorLastStep: null,
        twoFactorRecoveryHashes: [],
      },
    });
  }
}
