import { Schema, model, Document, Types } from "mongoose";

export type FmsStatus = "Active" | "Inactive";

export interface OrganizationNodeDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  nodeTypeId: Types.ObjectId;
  parentNodeId: Types.ObjectId | null;
  status: FmsStatus;
  displayOrder: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const organizationNodeSchema = new Schema<OrganizationNodeDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },
    nodeTypeId: { type: Schema.Types.ObjectId, ref: "NodeType", required: true },
    parentNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", default: null },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

organizationNodeSchema.index({ parentNodeId: 1 });
organizationNodeSchema.index({ nodeTypeId: 1 });
organizationNodeSchema.index({ status: 1 });
// Default listing sort (displayOrder asc) and the "latest first" alternative.
organizationNodeSchema.index({ displayOrder: 1 });
organizationNodeSchema.index({ createdAt: -1 });

export const OrganizationNodeModel = model<OrganizationNodeDocument>(
  "OrganizationNode",
  organizationNodeSchema
);
