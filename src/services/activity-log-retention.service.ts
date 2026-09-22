import { UserActivityLogModel } from "../models/UserActivityLog";
import { getOrCreateConfig } from "./fms/system-config.service";

/**
 * Deletes UserActivityLog documents older than the Super-Admin-configured
 * retention window. `activityLogRetentionDays === 0` means "keep
 * indefinitely" — security logs are never auto-deleted unless a retention
 * policy explicitly requires it.
 */
export async function runActivityLogRetentionSweep(): Promise<void> {
  try {
    const config = await getOrCreateConfig();
    if (!config.activityLogRetentionDays || config.activityLogRetentionDays <= 0) return;

    const cutoff = new Date(Date.now() - config.activityLogRetentionDays * 24 * 60 * 60 * 1000);
    const result = await UserActivityLogModel.deleteMany({ createdAt: { $lt: cutoff } });

    if (result.deletedCount) {
      console.log(
        `[activity-log-retention] purged ${result.deletedCount} log(s) older than ${config.activityLogRetentionDays} day(s).`
      );
    }
  } catch (error) {
    console.error("[activity-log-retention] sweep failed:", error);
  }
}
