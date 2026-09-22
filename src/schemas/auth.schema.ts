import { z } from "zod";
import { USER_ROLES } from "../models/User";
import { PASSWORD_POLICY_MESSAGE, PASSWORD_POLICY_REGEX } from "../utils/password";

const passwordSchema = z.string().min(8, PASSWORD_POLICY_MESSAGE).regex(PASSWORD_POLICY_REGEX, {
  message: PASSWORD_POLICY_MESSAGE,
});

export const signupSchema = z.object({
  fullname: z.string().trim().min(2, "Full name must be at least 2 characters.").max(150),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required.")
    .email("Enter a valid email address."),
  password: passwordSchema,
  countryCode: z.string().trim().min(1, "Country code is required.").max(6),
  phone: z
    .string()
    .trim()
    .min(6, "Enter a valid phone number.")
    .max(15, "Enter a valid phone number.")
    .regex(/^\d+$/, "Phone number must contain digits only."),
  role: z.enum(USER_ROLES).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Email is required.").email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

const mobileNumberSchema = z
  .string()
  .trim()
  .min(6, "Enter a valid mobile number.")
  .max(15, "Enter a valid mobile number.")
  .regex(/^\d+$/, "Mobile number must contain digits only.");

export const requestLoginOtpSchema = z.object({
  mobileNumber: mobileNumberSchema,
});

export const verifyLoginOtpSchema = z.object({
  mobileNumber: mobileNumberSchema,
  otp: z.string().trim().min(4, "Enter the OTP.").max(10).regex(/^\d+$/, "OTP must contain digits only."),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Email is required.").email("Enter a valid email address."),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is required."),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: passwordSchema,
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required."),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestLoginOtpInput = z.infer<typeof requestLoginOtpSchema>;
export type VerifyLoginOtpInput = z.infer<typeof verifyLoginOtpSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
