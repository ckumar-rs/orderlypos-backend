import { z } from "zod";

// Query params for GET /v1/notifications. Same reasoning as
// `auditLogListQuerySchema` (audit.ts): `ZodValidationPipe` only binds to
// `@Body()`, not `@Query()`, so this is parsed manually with `.safeParse()`
// in the controller — shared here so the frontend hook builds a query
// string the backend actually accepts.
export const notificationListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type NotificationListQueryDto = z.infer<
  typeof notificationListQuerySchema
>;
