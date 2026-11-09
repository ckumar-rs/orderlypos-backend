import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  STAFF_ROLES,
  type AuthProfile,
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type LoginDto,
  type PinLoginDto,
  type RegisterDto,
  type ResetPasswordDto,
  type SessionUser,
  type UpdateProfileDto,
} from '@nodedr-restaurant/types';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../modules/email/email.service';
import {
  seedBranchSettings,
  seedRestaurantSettings,
} from '../modules/settings/settings-kv';
import { PrismaService } from '../prisma/prisma.service';
import { TwoFactorService } from './two-factor.service';
import { authenticatorCounter, readClientData, verifyAssertion } from './webauthn';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly challenges = new Map<string, { challenge: string; expires: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private toSessionUser(user: {
    id: string;
    restaurantId: string;
    name: string;
    roleId: string;
    role: { name: string; permissions: { permission: { key: string } }[] };
  }): SessionUser {
    return {
      id: user.id,
      restaurantId: user.restaurantId,
      name: user.name,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions: user.role.permissions.map((rp) => rp.permission.key),
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, isActive: true },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Only asked for after the password is right, so the response never
    // reveals which emails exist or which accounts use two-factor.
    if (user.twoFactorEnabled) {
      await this.twoFactor.verifyLogin(user, dto.totp);
    }

    return this.issueSession(user);
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BadRequestException(
        'An account with this email already exists',
      );
    }

    // Permissions are global, not per-tenant — upsert (idempotent) outside
    // the transaction below rather than re-creating them per restaurant.
    for (const permission of PERMISSIONS) {
      await this.prisma.permission.upsert({
        where: { key: permission.key },
        update: {},
        create: permission,
      });
    }
    const allPermissions = await this.prisma.permission.findMany();
    const permissionByKey = new Map(allPermissions.map((p) => [p.key, p]));

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const owner = await this.prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: { name: dto.restaurantName },
      });
      const branch = await tx.branch.create({
        data: { restaurantId: restaurant.id, name: dto.branchName },
      });
      await seedRestaurantSettings(tx, restaurant.id);
      await seedBranchSettings(tx, branch.id);

      let ownerRoleId = '';
      for (const roleName of STAFF_ROLES) {
        const role = await tx.role.create({
          data: {
            restaurantId: restaurant.id,
            name: roleName,
            label: roleName.replace(/_/g, ' '),
          },
        });
        if (roleName === 'OWNER') ownerRoleId = role.id;

        const grantedKeys = DEFAULT_ROLE_PERMISSIONS[roleName];
        await tx.rolePermission.createMany({
          data: grantedKeys
            .map((key) => permissionByKey.get(key))
            .filter((p): p is NonNullable<typeof p> => Boolean(p))
            .map((permission) => ({
              roleId: role.id,
              permissionId: permission.id,
            })),
        });
      }

      const user = await tx.user.create({
        data: {
          restaurantId: restaurant.id,
          roleId: ownerRoleId,
          name: dto.ownerName,
          email: dto.email,
          passwordHash,
        },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });

      await tx.userBranch.create({
        data: { userId: user.id, branchId: branch.id },
      });

      return user;
    });

    return this.issueSession(owner);
  }

  async hasAnyRestaurant(): Promise<boolean> {
    const restaurant = await this.prisma.restaurant.findFirst({
      select: { id: true },
    });
    return restaurant !== null;
  }

  async pinLogin(dto: PinLoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });

    if (!user || !user.isActive || !user.pinHash) {
      throw new UnauthorizedException('PIN login not available for this user');
    }
    // A 4-8 digit PIN must not be a way around the second factor.
    if (user.twoFactorEnabled) {
      throw new UnauthorizedException(
        'PIN login is off for accounts with two-factor authentication — sign in with your password',
      );
    }

    const valid = await bcrypt.compare(dto.pin, user.pinHash);
    if (!valid) {
      throw new UnauthorizedException('Incorrect PIN');
    }

    return this.issueSession(user);
  }

  async webauthnRegisterOptions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new UnauthorizedException('Passkey was not recognized');
    return {
      ...this.passkeyOptions(`reg:${userId}`),
      user: {
        id: Buffer.from(user.id).toString('base64url'),
        name: user.email ?? user.id,
        displayName: user.name,
      },
    };
  }

  async webauthnRegisterVerify(
    userId: string,
    rpId: string,
    body: { credentialId: string; publicKey: string; clientDataJSON: string },
  ) {
    const client = this.readPasskey(`reg:${userId}`, body.clientDataJSON, 'webauthn.create', rpId);
    await this.prisma.webAuthnCredential.create({
      data: { userId, credentialId: body.credentialId, publicKey: body.publicKey },
    });
    return { ok: true, origin: client.origin };
  }

  async webauthnLoginOptions(email: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      include: { webauthnCredentials: { select: { credentialId: true } } },
    });
    const options = this.passkeyOptions(`login:${email.toLowerCase()}`);
    return {
      ...options,
      allowCredentials: (user?.webauthnCredentials ?? []).map((row) => ({
        type: 'public-key' as const,
        id: row.credentialId,
      })),
    };
  }

  async webauthnLoginVerify(
    rpId: string,
    body: {
      email: string;
      credentialId: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
      totp?: string;
    },
  ) {
    this.readPasskey(`login:${body.email.toLowerCase()}`, body.clientDataJSON, 'webauthn.get', rpId);
    const credential = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: body.credentialId },
      include: {
        user: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      },
    });
    if (!credential || !credential.user.isActive || credential.user.email?.toLowerCase() !== body.email.toLowerCase()) {
      throw new UnauthorizedException('Passkey was not recognized');
    }
    const ok = verifyAssertion({
      publicKeySpki: Buffer.from(credential.publicKey, 'base64url'),
      authenticatorData: Buffer.from(body.authenticatorData, 'base64url'),
      clientDataJSON: Buffer.from(body.clientDataJSON, 'base64url'),
      signature: Buffer.from(body.signature, 'base64url'),
    });
    if (!ok) throw new UnauthorizedException('Passkey was not recognized');
    const counter = authenticatorCounter(Buffer.from(body.authenticatorData, 'base64url'));
    if (credential.counter > 0 && counter > 0 && counter <= credential.counter) {
      throw new UnauthorizedException('Passkey was already used');
    }
    if (counter > 0) {
      await this.prisma.webAuthnCredential.update({
        where: { id: credential.id },
        data: { counter },
      });
    }
    if (credential.user.twoFactorEnabled) {
      await this.twoFactor.verifyLogin(credential.user, body.totp);
    }
    return this.issueSession(credential.user);
  }

  async webauthnCredentials(userId: string) {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { userId },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  async webauthnRemove(userId: string, id: string) {
    const row = await this.prisma.webAuthnCredential.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Passkey not found');
    await this.prisma.webAuthnCredential.delete({ where: { id } });
    return { ok: true };
  }

  private passkeyOptions(key: string) {
    const challenge = randomBytes(32).toString('base64url');
    this.challenges.set(key, { challenge, expires: Date.now() + 5 * 60_000 });
    return {
      challenge,
      timeout: 60_000,
      pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
      authenticatorSelection: { userVerification: 'preferred' as const, residentKey: 'preferred' as const },
    };
  }

  private readPasskey(key: string, clientDataJSON: string, type: string, rpId: string) {
    const pending = this.challenges.get(key);
    this.challenges.delete(key);
    if (!pending || pending.expires < Date.now()) {
      throw new UnauthorizedException('Passkey challenge expired');
    }
    const client = readClientData(Buffer.from(clientDataJSON, 'base64url'));
    if (client.type !== type || client.challenge !== pending.challenge) {
      throw new UnauthorizedException('Passkey challenge expired');
    }
    const host = new URL(client.origin).hostname;
    if (host !== rpId) throw new UnauthorizedException('Passkey origin does not match this site');
    return client;
  }

  async recordLogout(token: string | undefined) {
    if (!token) return;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      await this.audit.record({
        userId: payload.sub,
        action: 'auth.logout',
        entity: 'User',
        entityId: payload.sub,
      });
    } catch {
      // An expired cookie still clears. There is no user to attach.
    }
  }

  async getProfile(userId: string): Promise<AuthProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        restaurant: { select: { name: true } },
        role: {
          include: { permissions: { include: { permission: true } } },
        },
        branches: { select: { branch: { select: { id: true, name: true } } } },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session no longer valid');
    }
    return {
      ...this.toSessionUser(user),
      email: user.email,
      phone: user.phone,
      restaurantName: user.restaurant.name,
      roleLabel: user.role.label,
      branches: user.branches.map((row) => row.branch),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<AuthProfile> {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing || !existing.isActive) {
      throw new UnauthorizedException('Session no longer valid');
    }

    const email =
      dto.email === undefined
        ? undefined
        : dto.email === null || dto.email.trim() === ''
          ? null
          : dto.email.trim().toLowerCase();
    const phone =
      dto.phone === undefined
        ? undefined
        : dto.phone === null || dto.phone.trim() === ''
          ? null
          : dto.phone.trim();

    if (email) {
      const clash = await this.prisma.user.findFirst({
        where: {
          restaurantId: existing.restaurantId,
          email,
          id: { not: userId },
        },
      });
      if (clash) {
        throw new ConflictException('Another account already uses this email');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        ...(email !== undefined ? { email } : {}),
        ...(phone !== undefined ? { phone } : {}),
      },
    });

    await this.audit.record({
      userId,
      action: 'profile.updated',
      entity: 'User',
      entityId: userId,
      metadata: { name: dto.name, email, phone },
    });

    return this.getProfile(userId);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true, passwordHash: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session no longer valid');
    }
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });

    await this.audit.record({
      userId,
      action: 'profile.password_changed',
      entity: 'User',
      entityId: userId,
    });

    return { ok: true };
  }

  private hashResetToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private appBaseUrl() {
    return (
      this.config.get<string>('APP_URL') ??
      this.config.get<string>('PUBLIC_WEB_URL') ??
      this.config.get<string>('NEXT_PUBLIC_SITE_URL') ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /**
   * Always returns the same shape so callers cannot probe which emails exist.
   * Sends mail when the restaurant (or instance) has SMTP configured.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      select: { id: true, name: true, email: true, restaurantId: true },
    });

    if (user?.email) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: this.hashResetToken(token),
          passwordResetExpiresAt: expiresAt,
        },
      });

      const link = `${this.appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      const canEmail = await this.email.isConfiguredFor(user.restaurantId);
      if (canEmail) {
        try {
          await this.email.send(
            {
              to: user.email,
              subject: 'Reset your OrderlyPOS password',
              text: [
                `Hi ${user.name},`,
                '',
                'We received a request to reset your OrderlyPOS password.',
                `Open this link within one hour to choose a new password:`,
                link,
                '',
                'If you did not ask for this, you can ignore this email.',
              ].join('\n'),
            },
            user.restaurantId,
          );
        } catch (err) {
          this.logger.warn(
            `Password reset email failed for ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // Self-hosted installs without SMTP still get a usable path via server logs.
        this.logger.warn(
          `Password reset for ${user.email} — email is not configured. Reset link (1h): ${link}`,
        );
      }

      await this.audit.record({
        userId: user.id,
        action: 'auth.password_reset_requested',
        entity: 'User',
        entityId: user.id,
        metadata: { emailed: canEmail },
      });
    }

    return {
      ok: true,
      message:
        'If that email is on an account, we sent reset instructions. Check your inbox, or ask an owner to reset your password under Settings → Staff when email is not set up.',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hashResetToken(dto.token.trim());
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
        isActive: true,
      },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, 12),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    await this.audit.record({
      userId: user.id,
      action: 'auth.password_reset_completed',
      entity: 'User',
      entityId: user.id,
    });

    return { ok: true };
  }

  private async issueSession(
    user: Parameters<AuthService['toSessionUser']>[0],
  ) {
    const sessionUser = this.toSessionUser(user);
    const token = await this.jwt.signAsync({ sub: user.id });
    await this.audit.record({
      userId: user.id,
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      metadata: { role: sessionUser.roleName },
    });
    return { token, user: sessionUser };
  }
}
