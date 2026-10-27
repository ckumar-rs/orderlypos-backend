import { z } from "zod";

export const createRoleSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  permissionKeys: z.array(z.string().min(1)).default([]),
});
export type CreateRoleDto = z.infer<typeof createRoleSchema>;

// `name` is deliberately absent — a role's name is immutable once created
// (system or custom); only its display label and permission grants can
// change via PATCH.
export const updateRoleSchema = z.object({
  label: z.string().min(1).optional(),
  permissionKeys: z.array(z.string().min(1)).optional(),
});
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
