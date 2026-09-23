import { Schema, model, Document, Types } from "mongoose";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";

export type FmsStatus = "Active" | "Inactive";

export interface BudgetSetupAttachment {
  _id: Types.ObjectId;
  fileName: string;
  originalName: string;
  fileUrl: string;
  mimeType: string;
  size: number;
  uploadedBy: Types.ObjectId | null;
  uploadedAt: Date;
}

/**
 * A Budget Setup is the single money pool for one (Financial Year, root
 * Organization Node, root Scheme/Head Node) combination — the source that
 * the future Budget Allocation module draws down from. `allocatedAmount` is
 * a running total maintained transactionally (see reserveBudgetAmount /
 * releaseBudgetAmount in budget-setup.service.ts) rather than computed by
 * summing allocation records on every read, so remaining-budget checks stay
 * cheap and race-free under concurrent allocation requests.
 */
export interface BudgetSetupDocument extends Document {
  _id: Types.ObjectId;
  financialYearId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadNodeId: Types.ObjectId;
  originalAmount: number;
  allocatedAmount: number;
  remarks: string | null;
  attachments: Types.DocumentArray<BudgetSetupAttachment>;
  status: FmsStatus;
  // ---- GLOBAL FINANCIAL APPROVAL WORKFLOW (Maker/Verifier/Checker) ----
  // A Budget Setup only counts as poolable money for Budget Allocation once
  // approvalStatus is APPROVED (see resolveScope in
  // budget-allocation.service.ts) — a pending or rejected Budget Setup's
  // originalAmount is real on the record but not yet real to the rest of
  // the system. workflowSnapshot is captured once at creation and never
  // re-derived, so a later change to the node's role configuration can't
  // reinterpret an existing record's workflow (spec §20).
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: Types.ObjectId | null;
  verifierId: Types.ObjectId | null;
  checkerId: Types.ObjectId | null;
  holdingAmount: number;
  approvedAmount: number;
  transferredAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: Types.ObjectId | null;
  rejectedAt: Date | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const budgetSetupAttachmentSchema = new Schema<BudgetSetupAttachment>(
  {
    fileName: { type: String, required: true },
    originalName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const budgetSetupSchema = new Schema<BudgetSetupDocument>(
  {
    financialYearId: { type: Schema.Types.ObjectId, ref: "FinancialYear", required: true },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    schemeHeadNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    originalAmount: { type: Number, required: true, min: 1 },
    allocatedAmount: { type: Number, required: true, default: 0, min: 0 },
    remarks: { type: String, trim: true, maxlength: 1000, default: null },
    attachments: { type: [budgetSetupAttachmentSchema], default: [] },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    // Defaults to APPROVED (not a pending status) so records created before
    // this workflow existed — and any hydrated read of them before the
    // one-off backfill script runs — behave as already-approved rather than
    // silently disappearing from Budget Allocation's poolable funds.
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, default: "APPROVED" },
    workflowSnapshot: {
      type: {
        makerRequired: { type: Boolean, required: true },
        verifierRequired: { type: Boolean, required: true },
        checkerRequired: { type: Boolean, required: true },
      },
      default: () => ({ makerRequired: true, verifierRequired: false, checkerRequired: false }),
      _id: false,
    },
    makerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifierId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    checkerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    holdingAmount: { type: Number, required: true, default: 0, min: 0 },
    approvedAmount: { type: Number, required: true, default: 0, min: 0 },
    transferredAmount: { type: Number, required: true, default: 0, min: 0 },
    verifiedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Deliberately NOT unique — multiple Budget Setups (e.g. an initial sanction
// plus later top-up tranches) are allowed for the same (Financial Year, root
// Organization Node, root Scheme/Head Node). Budget Allocation pools every
// matching Budget Setup together as one combined fund (see reserveFromScope
// in budget-allocation.service.ts) rather than requiring exactly one.
budgetSetupSchema.index({ financialYearId: 1, organizationNodeId: 1, schemeHeadNodeId: 1 });
budgetSetupSchema.index({ status: 1 });
budgetSetupSchema.index({ approvalStatus: 1 });
// Filtering by only one of these (without financialYearId) can't use the
// compound index above — financialYearId isn't a leftmost prefix match.
budgetSetupSchema.index({ organizationNodeId: 1 });
budgetSetupSchema.index({ schemeHeadNodeId: 1 });
// Default listing sort (GLOBAL LISTING PAGE RULES §3: latest first).
budgetSetupSchema.index({ createdAt: -1 });

export const BudgetSetupModel = model<BudgetSetupDocument>("BudgetSetup", budgetSetupSchema);
