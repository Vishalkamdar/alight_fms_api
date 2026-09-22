import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import {
  FmsOtpProviderModel,
  SENSITIVE_CONFIG_KEYS,
  type FmsOtpProviderDocument,
} from "../../models/fms/FmsOtpProvider";
import { decryptSecret, encryptSecret, maskSecret } from "../../utils/encryption";
import type {
  CreateOtpProviderInput,
  OtpProviderListQuery,
  UpdateOtpProviderInput,
} from "../../schemas/fms/otp-provider.schema";

interface ActorContext {
  actorId: Types.ObjectId;
  ipAddress: string | null;
  userAgent?: string | null;
}

export interface SanitizedOtpProvider {
  _id: string;
  providerName: string;
  providerCode: string;
  priority: number;
  isEnabled: boolean;
  configuration: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function encryptConfiguration(configuration: Record<string, unknown>): Record<string, unknown> {
  const result = { ...configuration };
  for (const key of SENSITIVE_CONFIG_KEYS) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) {
      result[key] = encryptSecret(value);
    }
  }
  return result;
}

/** Never returns a sensitive value in the clear — masked to its last 4 characters at most. */
function sanitize(provider: FmsOtpProviderDocument): SanitizedOtpProvider {
  const configuration: Record<string, unknown> = { ...(provider.configuration ?? {}) };
  for (const key of SENSITIVE_CONFIG_KEYS) {
    const raw = configuration[key];
    if (typeof raw === "string" && raw.length > 0) {
      try {
        configuration[key] = maskSecret(decryptSecret(raw));
      } catch {
        configuration[key] = "********";
      }
    }
  }

  return {
    _id: String(provider._id),
    providerName: provider.providerName,
    providerCode: provider.providerCode,
    priority: provider.priority,
    isEnabled: provider.isEnabled,
    configuration,
    createdBy: provider.createdBy ? String(provider.createdBy) : null,
    updatedBy: provider.updatedBy ? String(provider.updatedBy) : null,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

async function findByIdOr404(id: string): Promise<FmsOtpProviderDocument> {
  const provider = await FmsOtpProviderModel.findById(id);
  if (!provider) throw new AppError(404, "OTP provider not found.");
  return provider;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listProviders(query: OtpProviderListQuery): Promise<ListResult<SanitizedOtpProvider>> {
  const filter: Record<string, unknown> = {};
  if (query.isEnabled !== undefined) filter.isEnabled = query.isEnabled;

  const [docs, total] = await Promise.all([
    FmsOtpProviderModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FmsOtpProviderModel.countDocuments(filter),
  ]);

  return {
    items: docs.map(sanitize),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

export async function getProviderById(id: string): Promise<SanitizedOtpProvider> {
  return sanitize(await findByIdOr404(id));
}

export async function createProvider(
  input: CreateOtpProviderInput,
  context: ActorContext
): Promise<SanitizedOtpProvider> {
  const created = await FmsOtpProviderModel.create({
    providerName: input.providerName,
    providerCode: input.providerCode,
    priority: input.priority,
    isEnabled: input.isEnabled ?? true,
    configuration: encryptConfiguration(input.configuration ?? {}),
    createdBy: context.actorId,
    updatedBy: context.actorId,
  });

  await logActivity({
    user: context.actorId,
    action: "OTP_PROVIDER_CREATED",
    module: "FMS_CONFIG",
    description: `Created OTP provider "${created.providerName}" (priority ${created.priority}).`,
    entityType: "FmsOtpProvider",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return sanitize(created);
}

export async function updateProvider(
  id: string,
  input: UpdateOtpProviderInput,
  context: ActorContext
): Promise<SanitizedOtpProvider> {
  const provider = await findByIdOr404(id);
  const previousPriority = provider.priority;
  const previousEnabled = provider.isEnabled;

  if (input.providerName !== undefined) provider.providerName = input.providerName;
  if (input.providerCode !== undefined) provider.providerCode = input.providerCode;
  if (input.priority !== undefined) provider.priority = input.priority;
  if (input.isEnabled !== undefined) provider.isEnabled = input.isEnabled;
  if (input.configuration !== undefined) {
    // Merge rather than replace, so the admin can update one field (e.g.
    // senderId) without having to resend an already-encrypted secret back.
    provider.configuration = encryptConfiguration({
      ...(provider.configuration ?? {}),
      ...input.configuration,
    });
  }
  provider.updatedBy = context.actorId;
  await provider.save();

  if (input.priority !== undefined && input.priority !== previousPriority) {
    await logActivity({
      user: context.actorId,
      action: "OTP_PROVIDER_PRIORITY_CHANGED",
      module: "FMS_CONFIG",
      description: `Changed OTP provider "${provider.providerName}" priority from ${previousPriority} to ${provider.priority}.`,
      entityType: "FmsOtpProvider",
      entityId: provider._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
  if (input.isEnabled !== undefined && input.isEnabled !== previousEnabled) {
    await logActivity({
      user: context.actorId,
      action: provider.isEnabled ? "OTP_PROVIDER_ENABLED" : "OTP_PROVIDER_DISABLED",
      module: "FMS_CONFIG",
      description: `OTP provider "${provider.providerName}" ${provider.isEnabled ? "enabled" : "disabled"}.`,
      entityType: "FmsOtpProvider",
      entityId: provider._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
  await logActivity({
    user: context.actorId,
    action: "OTP_PROVIDER_UPDATED",
    module: "FMS_CONFIG",
    description: `Updated OTP provider "${provider.providerName}".`,
    entityType: "FmsOtpProvider",
    entityId: provider._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return sanitize(provider);
}

export async function updateProviderStatus(
  id: string,
  isEnabled: boolean,
  context: ActorContext
): Promise<SanitizedOtpProvider> {
  const provider = await findByIdOr404(id);
  if (provider.isEnabled !== isEnabled) {
    provider.isEnabled = isEnabled;
    provider.updatedBy = context.actorId;
    await provider.save();

    await logActivity({
      user: context.actorId,
      action: isEnabled ? "OTP_PROVIDER_ENABLED" : "OTP_PROVIDER_DISABLED",
      module: "FMS_CONFIG",
      description: `OTP provider "${provider.providerName}" ${isEnabled ? "enabled" : "disabled"}.`,
      entityType: "FmsOtpProvider",
      entityId: provider._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }
  return sanitize(provider);
}

export async function deleteProvider(id: string, context: ActorContext): Promise<void> {
  const provider = await findByIdOr404(id);
  await provider.deleteOne();

  await logActivity({
    user: context.actorId,
    action: "OTP_PROVIDER_UPDATED",
    module: "FMS_CONFIG",
    description: `Deleted OTP provider "${provider.providerName}".`,
    entityType: "FmsOtpProvider",
    entityId: provider._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}
