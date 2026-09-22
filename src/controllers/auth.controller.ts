import { Response } from "express";
import { Types } from "mongoose";
import * as authService from "../services/auth.service";
import { sendSuccess } from "../utils/apiResponse";
import { AppError } from "../utils/AppError";
import type { AuthenticatedRequest } from "../middleware/auth";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RefreshTokenInput,
  RequestLoginOtpInput,
  ResetPasswordInput,
  SignupInput,
  VerifyLoginOtpInput,
} from "../schemas/auth.schema";

function requestContext(req: AuthenticatedRequest): authService.RequestContext {
  return {
    userAgent: req.headers["user-agent"] ?? null,
    ipAddress: req.ip ?? null,
  };
}

export async function signup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as SignupInput;
  const user = await authService.signup(body, req.user);
  sendSuccess(res, user, { statusCode: 201, message: "Account created successfully." });
}

export async function login(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as LoginInput;
  const result = await authService.login(body, requestContext(req));
  sendSuccess(res, result, { message: "Login successful" });
}

export async function requestLoginOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { mobileNumber } = res.locals.body as RequestLoginOtpInput;
  await authService.requestLoginOtp(mobileNumber, requestContext(req));
  sendSuccess(res, null, { message: "OTP sent to your registered mobile number." });
}

export async function verifyLoginOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { mobileNumber, otp } = res.locals.body as VerifyLoginOtpInput;
  const result = await authService.loginWithOtp(mobileNumber, otp, requestContext(req));
  sendSuccess(res, result, { message: "Login successful" });
}

export async function me(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) throw new AppError(401, "Authentication required.");
  sendSuccess(res, authService.toSafeUser(req.user));
}

export async function refreshToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { refreshToken: rawToken } = res.locals.body as RefreshTokenInput;
  const result = await authService.refreshAccessToken(rawToken, requestContext(req));
  sendSuccess(res, result, { message: "Token refreshed." });
}

export async function logout(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { refreshToken: rawToken } = res.locals.body as RefreshTokenInput;
  await authService.logout(rawToken, requestContext(req));
  sendSuccess(res, null, { message: "Logged out." });
}

export async function logoutAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) throw new AppError(401, "Authentication required.");
  await authService.logoutAll(req.user._id as Types.ObjectId, requestContext(req));
  sendSuccess(res, null, { message: "Logged out from all devices." });
}

export async function changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) throw new AppError(401, "Authentication required.");
  const { currentPassword, newPassword } = res.locals.body as ChangePasswordInput;
  await authService.changePassword(req.user, currentPassword, newPassword, requestContext(req));
  sendSuccess(res, null, { message: "Password changed successfully." });
}

export async function forgotPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { email } = res.locals.body as ForgotPasswordInput;
  await authService.forgotPassword(email, requestContext(req));
  sendSuccess(res, null, {
    message: "If an account with that email exists, a password reset link has been sent.",
  });
}

export async function resetPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { token, password } = res.locals.body as ResetPasswordInput;
  await authService.resetPassword(token, password, requestContext(req));
  sendSuccess(res, null, { message: "Password reset successfully." });
}
