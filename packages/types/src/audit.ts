import { z } from "zod";

// Query params for GET /v1/audit-logs. `ZodValidationPipe` (backend) only
// binds to `@Body()`, not `@Query()` (see its own comment in
// apps/backend/src/common/pipes/zod-validation.pipe.ts), so this schema is
// parsed manually in the controller with `.safeParse()` instead. Shared here
// so the frontend hook builds a query string the backend actually accepts.
export const auditLogListQuerySchema = z.object({
  entity: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type AuditLogListQueryDto = z.infer<typeof auditLogListQuerySchema>;
