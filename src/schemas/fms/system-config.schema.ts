import { z } from "zod";

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Enter a valid hex color, e.g. #C92026.");

export const updateSystemConfigSchema = z.object({
  systemName: z.string().trim().min(2, "System name must be at least 2 characters.").max(150).optional(),
  primaryColor: hexColorSchema.optional(),
  secondaryColor: hexColorSchema.optional(),
});

export type UpdateSystemConfigInput = z.infer<typeof updateSystemConfigSchema>;
