import { Schema, model, Document, Types } from "mongoose";

export type NodeRoleConfigStatus = "Active" | "Inactive";

/**
 * Super Admin-controlled switchboard: which FMS roles (Maker/Verifier/
 * Checker) are even assignable on a given node. Admin's role assignments
 * are validated against this before they're allowed to take effect.
 * One record per node.
 */
export interface FmsNodeRoleConfigDocument extends Document {
  _id: Types.ObjectId;
  node: Types.ObjectId;
  makerEnabled: boolean;
  verifierEnabled: boolean;
  checkerEnabled: boolean;
  status: NodeRoleConfigStatus;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fmsNodeRoleConfigSchema = new Schema<FmsNodeRoleConfigDocument>(
  {
    node: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true, unique: true },
    makerEnabled: { type: Boolean, default: false },
    verifierEnabled: { type: Boolean, default: false },
    checkerEnabled: { type: Boolean, default: false },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const FmsNodeRoleConfigModel = model<FmsNodeRoleConfigDocument>(
  "FmsNodeRoleConfig",
  fmsNodeRoleConfigSchema
);
