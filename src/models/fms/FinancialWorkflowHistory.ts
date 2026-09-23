import { Schema, model, Document, Types } from "mongoose";

export const FINANCIAL_WORKFLOW_MODULES = ["BUDGET_SETUP", "BUDGET_ALLOCATION"] as const;
export type FinancialWorkflowModule = (typeof FINANCIAL_WORKFLOW_MODULES)[number];

/**
 * One append-only entry per workflow event (Maker submitted, Verifier
 * verified/rejected, Checker approved/rejected, ...) for ANY financial
 * record in ANY module — a single shared collection (rather than one per
 * module) since the shape is identical and it's queried the same way
 * regardless of module: "show me the full history for this record."
 */
export interface FinancialWorkflowHistoryDocument extends Document {
  _id: Types.ObjectId;
  module: FinancialWorkflowModule;
  recordId: Types.ObjectId;
  action: string;
  userId: Types.ObjectId | null;
  userRole: string | null;
  organizationNodeId: Types.ObjectId | null;
  previousStatus: string | null;
  newStatus: string;
  amount: number;
  holdingAmount: number;
  remarks: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

const financialWorkflowHistorySchema = new Schema<FinancialWorkflowHistoryDocument>(
  {
    module: { type: String, enum: FINANCIAL_WORKFLOW_MODULES, required: true },
    recordId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    userRole: { type: String, default: null },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", default: null },
    previousStatus: { type: String, default: null },
    newStatus: { type: String, required: true },
    amount: { type: Number, required: true },
    holdingAmount: { type: Number, required: true },
    remarks: { type: String, trim: true, maxlength: 1000, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

financialWorkflowHistorySchema.index({ module: 1, recordId: 1, createdAt: 1 });

export const FinancialWorkflowHistoryModel = model<FinancialWorkflowHistoryDocument>(
  "FinancialWorkflowHistory",
  financialWorkflowHistorySchema
);
