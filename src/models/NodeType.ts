import { Schema, model, Document, Types } from "mongoose";

export type FmsStatus = "Active" | "Inactive";

/**
 * Which node hierarchy a label belongs to. Organization Node and Scheme/Head
 * Node are entirely separate hierarchies (see models/SchemeHeadNode.ts) that
 * share this one label/type master — a label is tagged so the UI only offers
 * "Department"/"Branch"-style labels when creating an Organization Node, and
 * "Scheme"/"Head"-style labels when creating a Scheme/Head Node.
 */
export const NODE_CATEGORIES = ["ORGANIZATION", "SCHEME_HEAD"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export interface NodeTypeDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  code: string;
  nodeCategory: NodeCategory;
  description?: string;
  status: FmsStatus;
  displayOrder: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const nodeTypeSchema = new Schema<NodeTypeDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: 30,
    },
    // Defaults to ORGANIZATION so every label created before Scheme/Head
    // Node existed keeps behaving exactly as it did (backfilled by a one-off
    // migration for documents that predate this field).
    nodeCategory: { type: String, enum: NODE_CATEGORIES, required: true, default: "ORGANIZATION" },
    description: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

nodeTypeSchema.index({ nodeCategory: 1, status: 1 });

export const NodeTypeModel = model<NodeTypeDocument>("NodeType", nodeTypeSchema);
