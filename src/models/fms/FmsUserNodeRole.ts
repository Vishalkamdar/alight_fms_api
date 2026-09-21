import { Schema, model, Document, Types } from "mongoose";

export const FMS_ROLES = ["Maker", "Verifier", "Checker"] as const;
export type FmsRole = (typeof FMS_ROLES)[number];

export type AssignmentStatus = "Active" | "Inactive";

/**
 * User + Organization Node + FMS Role. Never a global role — every
 * assignment is scoped to one node. Application-level roles (Admin,
 * Node Head) live entirely separately on the User model.
 */
export interface FmsUserNodeRoleDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  node: Types.ObjectId;
  role: FmsRole;
  status: AssignmentStatus;
  assignedBy: Types.ObjectId;
  assignedAt: Date;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fmsUserNodeRoleSchema = new Schema<FmsUserNodeRoleDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    node: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    role: { type: String, enum: FMS_ROLES, required: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedAt: { type: Date, default: () => new Date() },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

fmsUserNodeRoleSchema.index({ user: 1, status: 1 });
fmsUserNodeRoleSchema.index({ node: 1, status: 1 });
/**
 * A user may hold this exact role on this node only once while Active.
 * Re-assigning after deactivation reactivates the existing record instead
 * of inserting a duplicate (see user-node-role.service.ts#createAssignment),
 * so this partial index never blocks that path.
 */
fmsUserNodeRoleSchema.index(
  { user: 1, node: 1, role: 1 },
  { unique: true, partialFilterExpression: { status: "Active" } }
);

export const FmsUserNodeRoleModel = model<FmsUserNodeRoleDocument>(
  "FmsUserNodeRole",
  fmsUserNodeRoleSchema
);
