import { z } from "zod";

export const comboComponentSchema = z.object({
  componentItemId: z.string(),
  quantity: z.number().int().positive().default(1),
});
export type ComboComponentDto = z.infer<typeof comboComponentSchema>;

export const setComboComponentsSchema = z.object({
  components: z.array(comboComponentSchema),
});
export type SetComboComponentsDto = z.infer<typeof setComboComponentsSchema>;
