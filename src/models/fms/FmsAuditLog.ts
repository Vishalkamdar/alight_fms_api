import { Schema, model, Document, Types } from "mongoose";

export const FMS_AUDIT_ENTITIES = ["User", "FmsNodeRoleConfig", "FmsSystemConfig"] as const;
export type FmsAuditEntity = (typeof FMS_AUDIT_ENTITIES)[number];

/**
 * General-purpose, append-only administrative audit trail — distinct from
 * FmsUserNodeRoleAudit (which is specifically the role-assignment history).
 * Covers user CRUD, node-role configuration, and system/branding changes.
 */
export interface FmsAuditLogDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  action: string;
  entity: FmsAuditEntity;
  entityId: Types.ObjectId | null;
  previousValue: unknown;
  newValue: unknown;
  ipAddress: string | null;
  createdAt: Date;
}

const fmsAuditLogSchema = new Schema<FmsAuditLogDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true, trim: true },
    entity: { type: String, enum: FMS_AUDIT_ENTITIES, required: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    previousValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

fmsAuditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
fmsAuditLogSchema.index({ user: 1, createdAt: -1 });

export const FmsAuditLogModel = model<FmsAuditLogDocument>("FmsAuditLog", fmsAuditLogSchema);
