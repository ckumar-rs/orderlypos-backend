import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '@nodedr-restaurant/types';
import type { AuthenticatedRequest } from '../types/authenticated-request';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
