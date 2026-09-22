import { Types } from "mongoose";
import { logActivity } from "../../utils/activity-log";
import { FmsConfigurationModel, type FmsConfigurationDocument } from "../../models/fms/FmsConfiguration";
import type { UpdateConfigurationInput } from "../../schemas/fms/configuration.schema";

interface ActorContext {
  ipAddress: string | null;
  userAgent?: string | null;
}

/** The config is a singleton keyed by `key: "system"` — create it with defaults on first access. */
export async function getOrCreateConfiguration(): Promise<FmsConfigurationDocument> {
  const existing = await FmsConfigurationModel.findOne({ key: "system" });
  if (existing) return existing;
  return FmsConfigurationModel.create({ key: "system" });
}

export async function updateConfiguration(
  input: UpdateConfigurationInput,
  actorId: Types.ObjectId,
  context: ActorContext
): Promise<FmsConfigurationDocument> {
  const config = await getOrCreateConfiguration();
  const previousLoginMethod = config.loginAuthenticationMethod;
  const previousVerifierCheckerSms = config.verifierCheckerSmsAuthentication;
  const previousAllocationRequireHead = config.allocationRequireHead;

  if (input.loginAuthenticationMethod !== undefined) {
    config.loginAuthenticationMethod = input.loginAuthenticationMethod;
  }
  if (input.verifierCheckerSmsAuthentication !== undefined) {
    config.verifierCheckerSmsAuthentication = input.verifierCheckerSmsAuthentication;
  }
  if (input.allocationRequireHead !== undefined) {
    config.allocationRequireHead = input.allocationRequireHead;
  }
  if (input.otpSettings !== undefined) {
    config.otpSettings = { ...config.otpSettings, ...input.otpSettings };
  }
  config.updatedBy = actorId;
  await config.save();

  if (
    input.loginAuthenticationMethod !== undefined &&
    input.loginAuthenticationMethod !== previousLoginMethod
  ) {
    await logActivity({
      user: actorId,
      action: "LOGIN_METHOD_CHANGED",
      module: "FMS_CONFIG",
      description: `Login authentication method changed from ${previousLoginMethod} to ${config.loginAuthenticationMethod}.`,
      entityType: "FmsConfiguration",
      entityId: config._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
  if (
    input.verifierCheckerSmsAuthentication !== undefined &&
    input.verifierCheckerSmsAuthentication !== previousVerifierCheckerSms
  ) {
    await logActivity({
      user: actorId,
      action: "VERIFIER_CHECKER_SMS_AUTH_CHANGED",
      module: "FMS_CONFIG",
      description: `Verifier/Checker SMS authentication set to ${config.verifierCheckerSmsAuthentication ? "Enabled" : "Disabled"}.`,
      entityType: "FmsConfiguration",
      entityId: config._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
  if (
    input.allocationRequireHead !== undefined &&
    input.allocationRequireHead !== previousAllocationRequireHead
  ) {
    await logActivity({
      user: actorId,
      action: "ALLOCATION_HEAD_REQUIREMENT_CHANGED",
      module: "FMS_CONFIG",
      description: `Fund/Budget Allocation "Require Head" set to ${config.allocationRequireHead ? "Yes" : "No"}.`,
      entityType: "FmsConfiguration",
      entityId: config._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  return config;
}
