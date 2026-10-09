import { Schema, model, Document, Types } from "mongoose";

export type HeadAssignmentStatus = "Active" | "Inactive";

/**
 * User + Scheme/Head Node. Unlike FmsUserNodeRole, there is no per-head
 * "role" — the spec only ever describes a user being assigned to a Head or
 * not (never a Maker/Verifier/Checker-style tier per Head), so this is a
 * simple binary assignment. Head-wise restriction is opt-in per user: a
 * user with zero rows here is unrestricted on the Head axis (sees every
 * Head's data within their authorized Organization Node scope) — see
 * getAllowedHeadIdsForList in financial-workflow.service.ts.
 */
export interface FmsUserHeadRoleDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  head: Types.ObjectId;
  status: HeadAssignmentStatus;
  assignedBy: Types.ObjectId;
  assignedAt: Date;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fmsUserHeadRoleSchema = new Schema<FmsUserHeadRoleDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    head: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedAt: { type: Date, default: () => new Date() },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

fmsUserHeadRoleSchema.index({ user: 1, status: 1 });
fmsUserHeadRoleSchema.index({ head: 1, status: 1 });
/**
 * A user may hold an assignment to this exact Head only once while Active.
 * Re-assigning after deactivation reactivates the existing record instead
 * of inserting a duplicate (see user-head-role.service.ts#createAssignment).
 */
fmsUserHeadRoleSchema.index(
  { user: 1, head: 1 },
  { unique: true, partialFilterExpression: { status: "Active" } }
);

export const FmsUserHeadRoleModel = model<FmsUserHeadRoleDocument>(
  "FmsUserHeadRole",
  fmsUserHeadRoleSchema
);
