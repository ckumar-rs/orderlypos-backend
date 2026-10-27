import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  loginSchema,
  pinLoginSchema,
  registerSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Auth } from '../common/decorators/auth.decorator';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';

const SESSION_COOKIE = 'nodedr_session';
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A `Secure` cookie is silently dropped by every browser on a plain
// `http://` origin — including the default `http://<lan-ip>:1995` this app
// is normally reached at. Deriving this from `NODE_ENV === 'production'`
// (the old behavior) meant every Docker deployment set `Secure` on the
// session cookie yet was served over HTTP, so login "succeeded" but the
// browser never stored the cookie and every following request came back
// 401 Unauthorized. Default to false; opt in explicitly via COOKIE_SECURE
// once the app is actually served over HTTPS (see README).
function isCookieSecure(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  // Tighter than the app-wide default — unauthenticated and creates a full
  // restaurant + owner account, a more attractive abuse target than login.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @UsePipes(new ZodValidationPipe(registerSchema))
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.register(body as never);
    this.setSessionCookie(res, token);
    return { user };
  }

  // Tighter than the app-wide default (see register above) — login is a
  // classic credential-stuffing/brute-force target.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.login(body as never);
    this.setSessionCookie(res, token);
    return { user };
  }

  // Much tighter than login: a PIN is a short numeric secret (4-8 digits,
  // as low as 10,000 possibilities) rather than a full password, so the
  // app-wide throttle alone (300 req/min/IP) would let an attacker exhaust
  // a 4-digit PIN space in well under an hour against a known userId. This
  // caps that to 5/min/IP — the same budget register() uses for its own
  // higher-value target.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('pin-login')
  @UsePipes(new ZodValidationPipe(pinLoginSchema))
  async pinLogin(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.pinLogin(body as never);
    this.setSessionCookie(res, token);
    return { user };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookie = req.headers.cookie ?? '';
    const token = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    await this.authService.recordLogout(token ? decodeURIComponent(token) : undefined);
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isCookieSecure(),
    });
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('2fa/status')
  twoFactorStatus(@CurrentUser() user: SessionUser) {
    return this.twoFactor.status(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/setup')
  twoFactorSetup(@CurrentUser() user: SessionUser) {
    return this.twoFactor.setup(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  @UsePipes(new ZodValidationPipe(twoFactorCodeSchema))
  twoFactorEnable(
    @CurrentUser() user: SessionUser,
    @Body() body: { code: string },
  ) {
    return this.twoFactor.enable(user.id, body.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  @UsePipes(new ZodValidationPipe(twoFactorDisableSchema))
  twoFactorDisable(
    @CurrentUser() user: SessionUser,
    @Body() body: { password: string; code: string },
  ) {
    return this.twoFactor.disable(user.id, body.password, body.code);
  }

  // An owner/admin unlocks a staff member who lost their authenticator.
  @Auth('users.manage')
  @Post('2fa/reset/:userId')
  twoFactorReset(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
  ) {
    return this.twoFactor.adminReset(user.id, user.restaurantId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: unknown) {
    return { user };
  }

  @UseGuards(JwtAuthGuard)
  @Get('webauthn')
  webauthnList(@CurrentUser() user: SessionUser) {
    return this.authService.webauthnCredentials(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('webauthn/register/options')
  webauthnRegisterOptions(@CurrentUser() user: SessionUser) {
    return this.authService.webauthnRegisterOptions(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('webauthn/register/verify')
  webauthnRegisterVerify(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Body() body: { credentialId: string; publicKey: string; clientDataJSON: string },
  ) {
    return this.authService.webauthnRegisterVerify(user.id, req.hostname, body);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('webauthn/login/options')
  webauthnLoginOptions(@Body() body: { email?: string }) {
    return this.authService.webauthnLoginOptions(body.email ?? '');
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('webauthn/login/verify')
  async webauthnLoginVerify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body()
    body: {
      email: string;
      credentialId: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
      totp?: string;
    },
  ) {
    const { token, user } = await this.authService.webauthnLoginVerify(req.hostname, body);
    this.setSessionCookie(res, token);
    return { user };
  }

  // Public and unauthenticated — the marketing/login page needs this before
  // anyone is signed in, to decide whether to show the full landing pitch
  // (no restaurant registered on this instance yet) or just Sign in + View
  // documentation (someone already completed setup, so this is a live
  // business instance, not an unclaimed install).
  @Get('setup-status')
  async setupStatus() {
    const isSetup = await this.authService.hasAnyRestaurant();
    return { isSetup };
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isCookieSecure(),
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
}
