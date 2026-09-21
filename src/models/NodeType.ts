import { Schema, model, Document, Types } from "mongoose";

export type FmsStatus = "Active" | "Inactive";

export interface NodeTypeDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  code: string;
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
    description: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const NodeTypeModel = model<NodeTypeDocument>("NodeType", nodeTypeSchema);
