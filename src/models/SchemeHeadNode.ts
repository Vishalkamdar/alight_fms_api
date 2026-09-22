import { Schema, model, Document, Types } from "mongoose";

export type FmsStatus = "Active" | "Inactive";

/**
 * Scheme / Head Node — the financial master hierarchy (WHAT financial
 * scheme/head exists), entirely separate from OrganizationNode (WHO/WHERE).
 * A Scheme/Head Node's parent can only ever be another Scheme/Head Node —
 * storing it in its own collection makes that structurally impossible to
 * violate by accident, on top of the explicit validation in the service.
 *
 * hierarchyPath is a materialized "/ancestorId/.../parentId/" path (this
 * node's own id is NOT included in its own path) that makes descendant
 * lookups a single indexed prefix query instead of a recursive walk —
 * required for "large Scheme/Head hierarchies" per the performance spec.
 */
export interface SchemeHeadNodeDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  code: string;
  nodeCategory: "SCHEME_HEAD";
  nodeTypeId: Types.ObjectId;
  parentNodeId: Types.ObjectId | null;
  hierarchyPath: string;
  level: number;
  description?: string;
  status: FmsStatus;
  displayOrder: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schemeHeadNodeSchema = new Schema<SchemeHeadNodeDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: 40,
    },
    nodeCategory: { type: String, enum: ["SCHEME_HEAD"], default: "SCHEME_HEAD", immutable: true },
    nodeTypeId: { type: Schema.Types.ObjectId, ref: "NodeType", required: true },
    parentNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", default: null },
    hierarchyPath: { type: String, required: true, default: "/" },
    level: { type: Number, required: true, default: 0, min: 0 },
    description: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

schemeHeadNodeSchema.index({ parentNodeId: 1 });
schemeHeadNodeSchema.index({ nodeTypeId: 1 });
schemeHeadNodeSchema.index({ status: 1 });
schemeHeadNodeSchema.index({ hierarchyPath: 1 });
schemeHeadNodeSchema.index({ name: 1 });

export const SchemeHeadNodeModel = model<SchemeHeadNodeDocument>(
  "SchemeHeadNode",
  schemeHeadNodeSchema
);
