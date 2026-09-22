import { z } from "zod";

export const createOtpProviderSchema = z.object({
  providerName: z.string().trim().min(2, "Provider name must be at least 2 characters.").max(100),
  providerCode: z
    .string()
    .trim()
    .min(2, "Provider code must be at least 2 characters.")
    .max(40)
    .regex(/^[A-Za-z0-9_]+$/, "Provider code must contain only letters, numbers, and underscores."),
  priority: z.number().int("Priority must be a whole number.").min(1),
  isEnabled: z.boolean().optional().default(true),
  // Free-form — deliberately not validated field-by-field, since different
  // providers require different parameters (apiUrl, apiKey, apiSecret,
  // senderId, templateId, requestBody template, headers, ...).
  configuration: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updateOtpProviderSchema = createOtpProviderSchema.partial();

export const updateOtpProviderStatusSchema = z.object({ isEnabled: z.boolean() });

export const otpProviderListQuerySchema = z.object({
  isEnabled: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.string().default("priority"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateOtpProviderInput = z.infer<typeof createOtpProviderSchema>;
export type UpdateOtpProviderInput = z.infer<typeof updateOtpProviderSchema>;
export type OtpProviderListQuery = z.infer<typeof otpProviderListQuerySchema>;
