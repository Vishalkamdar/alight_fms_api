import { Schema, model, Document, Types } from "mongoose";
import type { HeadAssignmentStatus } from "./FmsUserHeadRole";

export const FMS_HEAD_ASSIGNMENT_ACTIONS = [
  "Head Assigned",
  "Head Activated",
  "Head Deactivated",
  "Head Removed",
] as const;
export type FmsHeadAssignmentAction = (typeof FMS_HEAD_ASSIGNMENT_ACTIONS)[number];

/**
 * Append-only audit trail for FmsUserHeadRole changes — mirrors
 * FmsUserNodeRoleAudit's parity/intent exactly. Application code only ever
 * inserts here, never updates or deletes.
 */
export interface FmsUserHeadRoleAuditDocument extends Document {
  _id: Types.ObjectId;
  assignment: Types.ObjectId | null;
  user: Types.ObjectId;
  head: Types.ObjectId;
  action: FmsHeadAssignmentAction;
  previousStatus: HeadAssignmentStatus | null;
  newStatus: HeadAssignmentStatus | null;
  performedBy: Types.ObjectId;
  performedAt: Date;
  createdAt: Date;
}

const fmsUserHeadRoleAuditSchema = new Schema<FmsUserHeadRoleAuditDocument>(
  {
    assignment: { type: Schema.Types.ObjectId, ref: "FmsUserHeadRole", default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    head: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    action: { type: String, enum: FMS_HEAD_ASSIGNMENT_ACTIONS, required: true },
    previousStatus: { type: String, enum: ["Active", "Inactive"], default: null },
    newStatus: { type: String, enum: ["Active", "Inactive"], default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    performedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

fmsUserHeadRoleAuditSchema.index({ user: 1, performedAt: -1 });
fmsUserHeadRoleAuditSchema.index({ head: 1, performedAt: -1 });
fmsUserHeadRoleAuditSchema.index({ assignment: 1 });

export const FmsUserHeadRoleAuditModel = model<FmsUserHeadRoleAuditDocument>(
  "FmsUserHeadRoleAudit",
  fmsUserHeadRoleAuditSchema
);
