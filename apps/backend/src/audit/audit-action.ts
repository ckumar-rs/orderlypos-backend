import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SessionUser } from '@nodedr-restaurant/types';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

const AUDIT_KEY = 'audit-action';

interface AuditMeta {
  action: string;
  entity: string;
}

/**
 * Marks a controller method as audit-logged: after it succeeds, one audit
 * row is written with the actor, the route params and the branch. Request
 * bodies are deliberately NOT logged — they can carry secrets (passwords,
 * API tokens) — so call AuditService.record() directly where the specifics
 * of a change matter.
 */
export const AuditAction = (action: string, entity: string) =>
  applyDecorators(
    SetMetadata(AUDIT_KEY, { action, entity } satisfies AuditMeta),
    UseInterceptors(AuditInterceptor),
  );

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: SessionUser }>();
    return next.handle().pipe(
      tap((result) => {
        if (!meta) return;
        const params = req.params as Record<string, string>;
        const resultId =
          result && typeof result === 'object' && 'id' in result
            ? String((result as { id: unknown }).id)
            : null;
        const branchId =
          typeof req.query.branchId === 'string'
            ? req.query.branchId
            : undefined;
        void this.audit
          .record({
            userId: req.user?.id ?? null,
            action: meta.action,
            entity: meta.entity,
            entityId: params.id ?? params.userId ?? params.orderId ?? resultId,
            metadata: { ...(branchId ? { branchId } : {}), ...params },
          })
          .catch((err: unknown) =>
            this.logger.warn(`audit write failed: ${String(err)}`),
          );
      }),
    );
  }
}
