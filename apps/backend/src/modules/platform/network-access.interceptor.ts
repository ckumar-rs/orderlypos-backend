import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { SessionUser } from '@nodedr-restaurant/types';
import { PlatformService } from './platform.service';

@Injectable()
export class NetworkAccessInterceptor implements NestInterceptor {
  constructor(private readonly platform: PlatformService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      user?: SessionUser;
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
      method: string;
      originalUrl?: string;
      url?: string;
    }>();
    if (!req.user?.restaurantId) return next.handle();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (
      path.includes('/v1/settings') ||
      path.includes('/v1/auth') ||
      path.includes('/v1/platform/security') ||
      path.includes('/v1/public')
    ) {
      return next.handle();
    }
    await this.platform.assertRequest(req.user.restaurantId, req);
    return next.handle();
  }
}
