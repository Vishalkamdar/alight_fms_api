import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Types } from "mongoose";
import { AppError } from "../utils/AppError";
import { FmsOtpModel, type OtpPurpose, type OtpActionContext } from "../models/fms/FmsOtp";
import { getOrCreateConfiguration } from "./fms/configuration.service";
import { sendSms } from "./sms.service";

// OTPs are short-lived, low-entropy, high-frequency — a lighter bcrypt cost
// than password hashing keeps verification fast without weakening security
// meaningfully, since attempts are also rate-limited server-side.
const OTP_HASH_ROUNDS = 8;

function generateNumericCode(length: number): string {
  const digits = "0123456789";
  return Array.from(crypto.randomBytes(length))
    .map((byte) => digits[byte % 10])
    .join("");
}

interface RequestOtpParams {
  user: Types.ObjectId | null;
  mobileNumber: string;
  purpose: OtpPurpose;
  context?: OtpActionContext;
}

/**
 * Generates, hashes, stores, and sends a new OTP — enforcing resend cooldown
 * and a rolling resend-attempt cap first. Never returns the plain code; the
 * only way to learn it is via the configured SMS provider (or the server
 * console in dev, when no provider is configured — see sms.service.ts).
 */
export async function requestOtp(params: RequestOtpParams): Promise<void> {
  const config = await getOrCreateConfiguration();
  const { length, expiryMinutes, maxAttempts, resendCooldownSeconds, maxResendAttempts } = config.otpSettings;

  const mostRecent = await FmsOtpModel.findOne({
    mobileNumber: params.mobileNumber,
    purpose: params.purpose,
  }).sort({ createdAt: -1 });

  if (mostRecent) {
    const secondsSinceLast = (Date.now() - mostRecent.createdAt.getTime()) / 1000;
    if (secondsSinceLast < resendCooldownSeconds) {
      throw new AppError(
        429,
        `Please wait ${Math.ceil(resendCooldownSeconds - secondsSinceLast)}s before requesting another OTP.`
      );
    }
  }

  const windowStart = new Date(Date.now() - resendCooldownSeconds * 1000 * maxResendAttempts);
  const recentCount = await FmsOtpModel.countDocuments({
    mobileNumber: params.mobileNumber,
    purpose: params.purpose,
    createdAt: { $gte: windowStart },
  });
  if (recentCount >= maxResendAttempts) {
    throw new AppError(429, "Too many OTP requests. Please try again later.");
  }

  const code = generateNumericCode(length);
  const otpHash = await bcrypt.hash(code, OTP_HASH_ROUNDS);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  const { success, providerCode } = await sendSms(params.mobileNumber, code);

  await FmsOtpModel.create({
    user: params.user,
    mobileNumber: params.mobileNumber,
    purpose: params.purpose,
    otpHash,
    context: params.context ?? {},
    maxAttempts,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 60 * 60 * 1000),
    providerUsed: providerCode,
  });

  if (!success) {
    throw new AppError(502, "Failed to send OTP. Please try again shortly.");
  }
}

interface ValidateOtpParams {
  mobileNumber: string;
  purpose: OtpPurpose;
  code: string;
  context?: OtpActionContext;
}

interface ValidateOtpResult {
  userId: Types.ObjectId | null;
}

/**
 * Validates and consumes the most recent pending OTP for this exact
 * (mobile, purpose, context) tuple — an OTP for one purpose or context can
 * never satisfy another (e.g. a LOGIN OTP cannot approve an invoice, and a
 * CHECKER_ACTION OTP for transaction A cannot approve transaction B).
 */
export async function validateOtp(params: ValidateOtpParams): Promise<ValidateOtpResult> {
  const filter: Record<string, unknown> = {
    mobileNumber: params.mobileNumber,
    purpose: params.purpose,
    consumed: false,
  };
  if (params.context?.action) filter["context.action"] = params.context.action;
  if (params.context?.transactionId) filter["context.transactionId"] = params.context.transactionId;
  if (params.context?.nodeId) filter["context.nodeId"] = params.context.nodeId;

  const otp = await FmsOtpModel.findOne(filter).select("+otpHash").sort({ createdAt: -1 });

  if (!otp) {
    throw new AppError(400, "No pending OTP found for this request. Please request a new one.");
  }
  if (otp.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, "This OTP has expired. Please request a new one.");
  }
  if (otp.attempts >= otp.maxAttempts) {
    throw new AppError(429, "Maximum OTP attempts exceeded. Please request a new one.");
  }

  const matches = await bcrypt.compare(params.code, otp.otpHash);
  if (!matches) {
    otp.attempts += 1;
    await otp.save();
    const remaining = otp.maxAttempts - otp.attempts;
    throw new AppError(
      400,
      remaining > 0
        ? `Incorrect OTP. ${remaining} attempt(s) remaining.`
        : "Incorrect OTP. No attempts remaining — request a new OTP."
    );
  }

  otp.consumed = true;
  otp.consumedAt = new Date();
  await otp.save();

  return { userId: otp.user };
}
