import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import * as otpService from "../../services/otp.service";
import { getOrCreateConfiguration } from "../../services/fms/configuration.service";
import { logActivity } from "../../utils/activity-log";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { RequestActionOtpInput, VerifyActionOtpInput } from "../../schemas/fms/action-otp.schema";

/**
 * Generic Maker/Verifier/Checker action-OTP gate — reusable by any future
 * transaction module (Invoice, Payroll, Fund/Budget Allocation, ...) per
 * spec: "future modules must use this centralized service." No transaction
 * module exists yet, so this only issues/consumes the OTP challenge itself;
 * the calling module is responsible for only finalizing its own action
 * after verify-action succeeds.
 */

export async function requestActionOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) throw new AppError(401, "Authentication required.");
  const { purpose, action, transactionId, nodeId } = res.locals.body as RequestActionOtpInput;

  const config = await getOrCreateConfiguration();
  if (!config.verifierCheckerSmsAuthentication) {
    throw new AppError(400, "SMS authentication is not required for Verifier/Checker actions.");
  }
  if (!req.user.phone) {
    throw new AppError(422, "Your account has no registered mobile number.");
  }

  await otpService.requestOtp({
    user: req.user._id,
    mobileNumber: req.user.phone,
    purpose,
    context: { action, transactionId, nodeId },
  });

  await logActivity({
    user: req.user._id,
    action: "ACTION_OTP_REQUESTED",
    module: "AUTH",
    description: `${purpose} OTP requested for "${action}" on transaction ${transactionId}.`,
    entityType: "Transaction",
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, null, { message: "OTP sent to your registered mobile number." });
}

export async function verifyActionOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) throw new AppError(401, "Authentication required.");
  const { purpose, action, transactionId, nodeId, otp } = res.locals.body as VerifyActionOtpInput;

  if (!req.user.phone) {
    throw new AppError(422, "Your account has no registered mobile number.");
  }

  try {
    await otpService.validateOtp({
      mobileNumber: req.user.phone,
      purpose,
      code: otp,
      context: { action, transactionId, nodeId },
    });
  } catch (error) {
    await logActivity({
      user: req.user._id,
      action: "ACTION_OTP_FAILED",
      module: "AUTH",
      description: `${purpose} OTP verification failed for "${action}" on transaction ${transactionId}.`,
      status: "FAILURE",
      entityType: "Transaction",
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
    throw error;
  }

  await logActivity({
    user: req.user._id,
    action: "ACTION_OTP_VERIFIED",
    module: "AUTH",
    description: `${purpose} OTP verified for "${action}" on transaction ${transactionId}.`,
    entityType: "Transaction",
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, { authorized: true }, { message: "OTP verified." });
}
