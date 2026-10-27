import { z } from "zod";

// Literal-string confirm, matching zulivio's restore safety gate exactly —
// a deliberate speed bump before the single most destructive action in
// this app (drops and recreates the entire shared Postgres instance).
export const restoreBackupSchema = z.object({
  confirm: z.literal("RESTORE"),
});
export type RestoreBackupDto = z.infer<typeof restoreBackupSchema>;

// Not @IsUrl-style strict URL validation on `endpoint` — deliberately a
// loose http(s):// prefix check (same reasoning as zulivio's
// SetBackupConfigDto): a real S3-compatible endpoint can be a bare IP with
// a port, and the actual validation that matters is the live connectivity
// probe `BackupService.setConfig()` performs before persisting anything.
export const setBackupConfigSchema = z.object({
  endpoint: z
    .string()
    .min(1)
    .regex(/^https?:\/\/.+/, "Endpoint must start with http:// or https://"),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1).optional(),
  intervalDays: z.coerce.number().int().min(1).max(30).optional(),
  retainCount: z.coerce.number().int().min(1).max(10).optional(),
});
export type SetBackupConfigDto = z.infer<typeof setBackupConfigSchema>;
