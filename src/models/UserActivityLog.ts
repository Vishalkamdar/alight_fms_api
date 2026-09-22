import { Schema, model, Document, Types } from "mongoose";

export const ACTIVITY_MODULES = [
  "AUTH",
  "USER",
  "FMS_CONFIG",
  "MASTER_DATA",
  "FINANCE",
  "PAYROLL",
] as const;
export type ActivityModule = (typeof ACTIVITY_MODULES)[number];

export const ACTIVITY_STATUSES = ["SUCCESS", "FAILURE"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * Centralized, append-only security/activity log — distinct from FmsAuditLog
 * (which records field-level before/after diffs for admin config changes).
 * This is the IP/user-agent-tagged trail used for security investigations
 * and the Activity page, reusable by every current and future module.
 */
export interface UserActivityLogDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId | null;
  action: string;
  module: ActivityModule;
  description: string;
  ipAddress: string | null;
  userAgent: string | null;
  entityType: string | null;
  entityId: Types.ObjectId | null;
  status: ActivityStatus;
  requestId: string | null;
  createdAt: Date;
}

const userActivityLogSchema = new Schema<UserActivityLogDocument>(
  {
    // Null only when no account could be attributed yet, e.g. a failed
    // login attempt against an email with no matching user.
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, trim: true },
    module: { type: String, enum: ACTIVITY_MODULES, required: true },
    description: { type: String, required: true, trim: true },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    entityType: { type: String, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ACTIVITY_STATUSES, required: true, default: "SUCCESS" },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

userActivityLogSchema.index({ user: 1, createdAt: -1 });
userActivityLogSchema.index({ module: 1, createdAt: -1 });
userActivityLogSchema.index({ action: 1, createdAt: -1 });
userActivityLogSchema.index({ createdAt: -1 });
userActivityLogSchema.index({ entityType: 1, entityId: 1 });

export const UserActivityLogModel = model<UserActivityLogDocument>(
  "UserActivityLog",
  userActivityLogSchema
);
