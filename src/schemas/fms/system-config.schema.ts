import { z } from "zod";

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Enter a valid hex color, e.g. #C92026.");

export const updateSystemConfigSchema = z.object({
  systemName: z.string().trim().min(2, "System name must be at least 2 characters.").max(150).optional(),
  primaryColor: hexColorSchema.optional(),
  secondaryColor: hexColorSchema.optional(),
  activityLogRetentionDays: z.coerce
    .number()
    .int("Retention days must be a whole number.")
    .min(0, "Retention days cannot be negative.")
    .max(3650, "Retention days cannot exceed 3650 (10 years).")
    .optional(),
});

export type UpdateSystemConfigInput = z.infer<typeof updateSystemConfigSchema>;
