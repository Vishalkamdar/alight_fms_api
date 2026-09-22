import { Types } from "mongoose";
import {
  UserActivityLogModel,
  type ActivityModule,
  type ActivityStatus,
} from "../models/UserActivityLog";

interface LogActivityParams {
  user?: Types.ObjectId | string | null;
  action: string;
  module: ActivityModule;
  description: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  entityType?: string | null;
  entityId?: Types.ObjectId | string | null;
  status?: ActivityStatus;
  requestId?: string | null;
}

/**
 * Fire-and-forget security/activity logging. Never throws — a logging
 * failure must never fail or roll back the business operation it describes.
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    await UserActivityLogModel.create({
      user: params.user ?? null,
      action: params.action,
      module: params.module,
      description: params.description,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      status: params.status ?? "SUCCESS",
      requestId: params.requestId ?? null,
    });
  } catch (error) {
    console.error("[activity-log] failed to record activity:", error);
  }
}
