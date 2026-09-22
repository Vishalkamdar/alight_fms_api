import { z } from "zod";
import { LOGIN_AUTH_METHODS } from "../../models/fms/FmsConfiguration";

export const otpSettingsSchema = z.object({
  length: z.number().int().min(4).max(10).optional(),
  expiryMinutes: z.number().int().min(1).max(60).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  resendCooldownSeconds: z.number().int().min(0).max(600).optional(),
  maxResendAttempts: z.number().int().min(1).max(20).optional(),
});

export const updateConfigurationSchema = z.object({
  loginAuthenticationMethod: z.enum(LOGIN_AUTH_METHODS).optional(),
  verifierCheckerSmsAuthentication: z.boolean().optional(),
  allocationRequireHead: z.boolean().optional(),
  otpSettings: otpSettingsSchema.optional(),
});

export type UpdateConfigurationInput = z.infer<typeof updateConfigurationSchema>;
