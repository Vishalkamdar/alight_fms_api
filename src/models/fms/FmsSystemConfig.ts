import { Schema, model, Document, Types } from "mongoose";

/**
 * Single global branding/config document. Always accessed via the fixed
 * `key: "system"` unique value (see system-config.service.ts) rather than
 * an id, so there is exactly one live record — a singleton enforced by a
 * unique index rather than a hardcoded ObjectId.
 */
export interface FmsSystemConfigDocument extends Document {
  _id: Types.ObjectId;
  key: "system";
  systemName: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  /** Activity log retention window in days. 0 means keep indefinitely. */
  activityLogRetentionDays: number;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fmsSystemConfigSchema = new Schema<FmsSystemConfigDocument>(
  {
    key: { type: String, enum: ["system"], default: "system", unique: true },
    systemName: { type: String, required: true, trim: true, default: "Fund Management System" },
    logoUrl: { type: String, default: null },
    primaryColor: { type: String, required: true, default: "#C92026" },
    secondaryColor: { type: String, required: true, default: "#223579" },
    activityLogRetentionDays: { type: Number, required: true, default: 0, min: 0, max: 3650 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const FmsSystemConfigModel = model<FmsSystemConfigDocument>(
  "FmsSystemConfig",
  fmsSystemConfigSchema
);
