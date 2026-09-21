import { Schema, model, Document, Types } from "mongoose";
import { FMS_ROLES, type FmsRole, type AssignmentStatus } from "./FmsUserNodeRole";

export const FMS_ASSIGNMENT_ACTIONS = [
  "Role Assigned",
  "Role Updated",
  "Role Activated",
  "Role Deactivated",
  "Role Removed",
] as const;
export type FmsAssignmentAction = (typeof FMS_ASSIGNMENT_ACTIONS)[number];

/**
 * Append-only audit trail for FmsUserNodeRole changes. Application code
 * only ever inserts here (see user-node-role.service.ts) — never updates
 * or deletes — so history survives even after the live assignment record
 * is removed.
 */
export interface FmsUserNodeRoleAuditDocument extends Document {
  _id: Types.ObjectId;
  assignment: Types.ObjectId | null;
  user: Types.ObjectId;
  node: Types.ObjectId;
  action: FmsAssignmentAction;
  previousRole: FmsRole | null;
  newRole: FmsRole | null;
  previousStatus: AssignmentStatus | null;
  newStatus: AssignmentStatus | null;
  performedBy: Types.ObjectId;
  performedAt: Date;
  createdAt: Date;
}

const fmsUserNodeRoleAuditSchema = new Schema<FmsUserNodeRoleAuditDocument>(
  {
    assignment: { type: Schema.Types.ObjectId, ref: "FmsUserNodeRole", default: null },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    node: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    action: { type: String, enum: FMS_ASSIGNMENT_ACTIONS, required: true },
    previousRole: { type: String, enum: FMS_ROLES, default: null },
    newRole: { type: String, enum: FMS_ROLES, default: null },
    previousStatus: { type: String, enum: ["Active", "Inactive"], default: null },
    newStatus: { type: String, enum: ["Active", "Inactive"], default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    performedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

fmsUserNodeRoleAuditSchema.index({ user: 1, performedAt: -1 });
fmsUserNodeRoleAuditSchema.index({ node: 1, performedAt: -1 });
fmsUserNodeRoleAuditSchema.index({ assignment: 1 });

export const FmsUserNodeRoleAuditModel = model<FmsUserNodeRoleAuditDocument>(
  "FmsUserNodeRoleAudit",
  fmsUserNodeRoleAuditSchema
);
