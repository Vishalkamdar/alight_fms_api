import { Types } from "mongoose";
import fs from "fs/promises";
import path from "path";
import { recordAudit } from "../../utils/fms/audit-log";
import { FmsSystemConfigModel, FmsSystemConfigDocument } from "../../models/fms/FmsSystemConfig";
import type { UpdateSystemConfigInput } from "../../schemas/fms/system-config.schema";
import { UPLOAD_ROOT_DIR } from "../../utils/fms/upload";

/** The config is a singleton keyed by `key: "system"` — create it with defaults on first access. */
export async function getOrCreateConfig(): Promise<FmsSystemConfigDocument> {
  const existing = await FmsSystemConfigModel.findOne({ key: "system" });
  if (existing) return existing;

  return FmsSystemConfigModel.create({ key: "system" });
}

export async function updateConfig(
  input: UpdateSystemConfigInput,
  actorId: Types.ObjectId,
  ipAddress: string | null
): Promise<FmsSystemConfigDocument> {
  const config = await getOrCreateConfig();
  const previousValue = config.toObject();

  if (input.systemName !== undefined) config.systemName = input.systemName;
  if (input.primaryColor !== undefined) config.primaryColor = input.primaryColor;
  if (input.secondaryColor !== undefined) config.secondaryColor = input.secondaryColor;
  config.updatedBy = actorId;

  await config.save();

  await recordAudit({
    user: actorId,
    action: "System Configuration Updated",
    entity: "FmsSystemConfig",
    entityId: config._id,
    previousValue,
    newValue: config.toObject(),
    ipAddress,
  });

  return config;
}

export async function replaceLogo(
  storedFileName: string,
  actorId: Types.ObjectId,
  ipAddress: string | null
): Promise<FmsSystemConfigDocument> {
  const config = await getOrCreateConfig();
  const previousLogoUrl = config.logoUrl;

  config.logoUrl = `/uploads/branding/${storedFileName}`;
  config.updatedBy = actorId;
  await config.save();

  // Best-effort cleanup of the previous logo file — never fail the request over it.
  if (previousLogoUrl) {
    const previousFileName = path.basename(previousLogoUrl);
    const previousFilePath = path.join(UPLOAD_ROOT_DIR, "branding", previousFileName);
    fs.unlink(previousFilePath).catch(() => {
      // Ignore — the file may already be gone, or this is a fresh singleton with no prior logo.
    });
  }

  await recordAudit({
    user: actorId,
    action: "System Logo Changed",
    entity: "FmsSystemConfig",
    entityId: config._id,
    previousValue: { logoUrl: previousLogoUrl },
    newValue: { logoUrl: config.logoUrl },
    ipAddress,
  });

  return config;
}
