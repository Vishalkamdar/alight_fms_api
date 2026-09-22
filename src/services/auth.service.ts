import { Types } from "mongoose";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";
import { UserModel, UserDocument, UserRole, DEFAULT_USER_ROLE } from "../models/User";
import { comparePassword, hashPassword } from "../utils/password";
import { signAccessToken } from "../utils/jwt";
import { parseDurationToSeconds } from "../utils/duration";
import { generateOpaqueToken, sha256Hex } from "../utils/hash";
import { logActivity } from "../utils/activity-log";
import {
  findActiveRefreshToken,
  issueRefreshToken,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
} from "../utils/refreshToken";
import {
  sendPasswordChangedEmail,
  sendPasswordResetConfirmationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "./email.service";
import type { LoginInput, SignupInput } from "../schemas/auth.schema";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface RequestContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export function toSafeUser(user: UserDocument) {
  return {
    _id: String(user._id),
    fullname: user.fullname,
    email: user.email,
    countryCode: user.countryCode,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function buildTokenResponse(user: UserDocument, context: RequestContext) {
  const accessToken = signAccessToken({
    sub: String(user._id),
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  const { rawToken: refreshToken } = await issueRefreshToken({
    userId: user._id,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });

  return {
    tokenType: "Bearer" as const,
    accessToken,
    expiresIn: parseDurationToSeconds(env.JWT_ACCESS_EXPIRES_IN),
    refreshToken,
    user: toSafeUser(user),
  };
}

export async function signup(input: SignupInput, requestedBy: UserDocument | undefined) {
  const email = input.email.toLowerCase().trim();

  const [emailTaken, phoneTaken] = await Promise.all([
    UserModel.exists({ email }),
    UserModel.exists({ phone: input.phone }),
  ]);

  if (emailTaken) {
    throw new AppError(409, "An account with this email already exists.", {
      email: ["Email already in use."],
    });
  }
  if (phoneTaken) {
    throw new AppError(409, "An account with this phone number already exists.", {
      phone: ["Phone number already in use."],
    });
  }

  // Only a Super Admin may create another Super Admin; a plain Admin caller's
  // requested role (if any) is otherwise honored, else the default applies.
  if (input.role === "Super Admin" && requestedBy?.role !== "Super Admin") {
    throw new AppError(403, "Only a Super Admin can create another Super Admin account.");
  }
  const role: UserRole = input.role ?? DEFAULT_USER_ROLE;

  const passwordHash = await hashPassword(input.password);

  const user = await UserModel.create({
    fullname: input.fullname,
    email,
    password: passwordHash,
    countryCode: input.countryCode,
    phone: input.phone,
    role,
  });

  void sendWelcomeEmail(user.email, user.fullname).catch((error: unknown) =>
    console.error("[email] failed to send welcome email:", error)
  );

  return toSafeUser(user);
}

export async function login(input: LoginInput, context: RequestContext) {
  const email = input.email.toLowerCase().trim();
  const user = await UserModel.findOne({ email }).select("+password");

  if (!user) {
    await logActivity({
      action: "LOGIN_FAILED",
      module: "AUTH",
      description: `Login attempt failed — no account found for ${email}.`,
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new AppError(401, "Invalid email or password.");
  }

  const passwordMatches = await comparePassword(input.password, user.password);
  if (!passwordMatches) {
    await logActivity({
      user: user._id,
      action: "LOGIN_FAILED",
      module: "AUTH",
      description: "Login attempt failed — incorrect password.",
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new AppError(401, "Invalid email or password.");
  }

  if (!user.isActive) {
    await logActivity({
      user: user._id,
      action: "LOGIN_FAILED",
      module: "AUTH",
      description: "Login attempt failed — account is deactivated.",
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new AppError(403, "Your account has been deactivated.");
  }

  user.lastLoginAt = new Date();
  await user.save();

  await logActivity({
    user: user._id,
    action: "LOGIN_SUCCESS",
    module: "AUTH",
    description: "User logged in successfully.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return buildTokenResponse(user, context);
}

export async function refreshAccessToken(rawToken: string, context: RequestContext) {
  const existing = await findActiveRefreshToken(rawToken);
  if (!existing) {
    throw new AppError(401, "Invalid or expired refresh token.");
  }

  const user = await UserModel.findById(existing.user);
  if (!user || !user.isActive) {
    throw new AppError(401, "Invalid or expired refresh token.");
  }

  const accessToken = signAccessToken({
    sub: String(user._id),
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  const { rawToken: newRefreshToken, document: newDocument } = await issueRefreshToken({
    userId: user._id,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });

  await revokeRefreshToken(existing, newDocument._id as Types.ObjectId);

  await logActivity({
    user: user._id,
    action: "REFRESH_TOKEN",
    module: "AUTH",
    description: "Access token refreshed.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return {
    tokenType: "Bearer" as const,
    accessToken,
    expiresIn: parseDurationToSeconds(env.JWT_ACCESS_EXPIRES_IN),
    refreshToken: newRefreshToken,
    user: toSafeUser(user),
  };
}

export async function logout(rawToken: string, context: RequestContext): Promise<void> {
  const existing = await findActiveRefreshToken(rawToken);
  if (existing) {
    await revokeRefreshToken(existing);
    await logActivity({
      user: existing.user,
      action: "LOGOUT",
      module: "AUTH",
      description: "User logged out.",
      status: "SUCCESS",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
}

export async function logoutAll(userId: Types.ObjectId, context: RequestContext): Promise<void> {
  await Promise.all([
    revokeAllRefreshTokensForUser(userId),
    UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }),
  ]);

  await logActivity({
    user: userId,
    action: "LOGOUT_ALL",
    module: "AUTH",
    description: "User logged out from all devices.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

export async function changePassword(
  user: UserDocument,
  currentPassword: string,
  newPassword: string,
  context: RequestContext
): Promise<void> {
  const fullUser = await UserModel.findById(user._id).select("+password");
  if (!fullUser) {
    throw new AppError(401, "Authentication required.");
  }

  const currentMatches = await comparePassword(currentPassword, fullUser.password);
  if (!currentMatches) {
    await logActivity({
      user: fullUser._id,
      action: "PASSWORD_CHANGED",
      module: "AUTH",
      description: "Password change failed — incorrect current password.",
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new AppError(400, "Current password is incorrect.", {
      currentPassword: ["Current password is incorrect."],
    });
  }

  fullUser.password = await hashPassword(newPassword);
  fullUser.tokenVersion += 1;
  await fullUser.save();

  await revokeAllRefreshTokensForUser(fullUser._id);

  await logActivity({
    user: fullUser._id,
    action: "PASSWORD_CHANGED",
    module: "AUTH",
    description: "Password changed successfully.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  void sendPasswordChangedEmail(fullUser.email, fullUser.fullname).catch((error: unknown) =>
    console.error("[email] failed to send password-changed email:", error)
  );
}

export async function forgotPassword(email: string, context: RequestContext): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await UserModel.findOne({ email: normalizedEmail });

  // Same response whether or not the account exists — never confirm/deny an email on file.
  if (!user) {
    await logActivity({
      action: "PASSWORD_RESET_REQUESTED",
      module: "AUTH",
      description: `Password reset requested for unknown email ${normalizedEmail}.`,
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return;
  }

  const rawToken = generateOpaqueToken(32);
  user.passwordResetToken = sha256Hex(rawToken);
  user.passwordResetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  const resetUrl = `${env.CLIENT_URL}/reset-password?token=${rawToken}`;

  await logActivity({
    user: user._id,
    action: "PASSWORD_RESET_REQUESTED",
    module: "AUTH",
    description: "Password reset requested.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  void sendPasswordResetEmail(user.email, user.fullname, resetUrl).catch((error: unknown) =>
    console.error("[email] failed to send password reset email:", error)
  );
}

export async function resetPassword(
  rawToken: string,
  newPassword: string,
  context: RequestContext
): Promise<void> {
  const tokenHash = sha256Hex(rawToken);

  const user = await UserModel.findOne({ passwordResetToken: tokenHash }).select(
    "+passwordResetToken +passwordResetExpires"
  );

  if (!user || !user.passwordResetExpires || user.passwordResetExpires.getTime() <= Date.now()) {
    await logActivity({
      action: "PASSWORD_RESET",
      module: "AUTH",
      description: "Password reset failed — invalid or expired reset token.",
      status: "FAILURE",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new AppError(400, "This password reset link is invalid or has expired.");
  }

  user.password = await hashPassword(newPassword);
  user.passwordResetToken = null;
  user.passwordResetExpires = null;
  user.tokenVersion += 1;
  await user.save();

  await revokeAllRefreshTokensForUser(user._id);

  await logActivity({
    user: user._id,
    action: "PASSWORD_RESET",
    module: "AUTH",
    description: "Password reset successfully.",
    status: "SUCCESS",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  void sendPasswordResetConfirmationEmail(user.email, user.fullname).catch((error: unknown) =>
    console.error("[email] failed to send password reset confirmation email:", error)
  );
}
