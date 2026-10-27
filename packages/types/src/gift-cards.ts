import { z } from "zod";

export const issueGiftCardSchema = z.object({
  initialValue: z.coerce.number().positive(),
  customerId: z.string().optional(),
});
export type IssueGiftCardDto = z.infer<typeof issueGiftCardSchema>;
