import { z } from "zod";

export const setPrioritySchema = z.object({
  isPriority: z.boolean(),
});
export type SetPriorityDto = z.infer<typeof setPrioritySchema>;

export const kitchenCourseSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  holdByDefault: z.boolean().optional(),
});
export type KitchenCourseDto = z.infer<typeof kitchenCourseSchema>;

export const kitchenStationSchema = z.object({
  name: z.string().trim().min(1).max(40),
  printerName: z.string().trim().max(80).optional(),
  role: z.enum(["COOK", "EXPO"]).optional(),
});
export type KitchenStationDto = z.infer<typeof kitchenStationSchema>;

export const fireCourseSchema = z.object({
  courseId: z.string().trim().min(1),
});
export type FireCourseDto = z.infer<typeof fireCourseSchema>;

export const kotLineStatusSchema = z.object({
  status: z.enum(["ACCEPTED", "PREPARING", "READY", "SERVED", "DELAYED"]),
  delayReason: z.string().trim().max(200).optional(),
});
export type KotLineStatusDto = z.infer<typeof kotLineStatusSchema>;
