import { Schema, model, Document, Types } from "mongoose";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";

export interface BudgetAllocationAttachment {
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
 * How much of this allocation's `amount` was actually drawn from one
 * specific underlying Budget Setup pool. A scope (Financial Year + root
 * Organization Node + root Scheme/Head Node) can have MULTIPLE Budget
 * Setups — an initial sanction plus later top-up tranches — pooled together
 * as one combined fund (see reserveFromScope in budget-allocation.service.ts).
 * A single allocation can therefore be split across more than one Budget
 * Setup record (oldest pool drawn down first); this breakdown is the full
 * audit trail of exactly which pool(s) funded it and how much came from each.
 */
export interface BudgetAllocationSourcePool {
  budgetSetupId: Types.ObjectId;
  amount: number;
}

/**
 * A commitment of money from a (Financial Year, root Organization Node, root
 * Scheme/Head Node) scope's pooled Budget Setups to a specific Organization
 * Node — optionally attributed to a Scheme/Head Node when the "Require Head"
 * configuration was enabled at the time this record was created.
 * `requireHeadAtCreation` and `headId` are captured on the record itself
 * (not just the activity log) because a later Super Admin toggle of the
 * global setting must NEVER reinterpret or rewrite an existing allocation's
 * meaning (spec §8) — the record has to carry its own history.
 */
export interface BudgetAllocationDocument extends Document {
  _id: Types.ObjectId;
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  // Whatever level of the scheme/head hierarchy the user selected (root
  // itself, or any descendant "child Head") — null when Require Head was
  // off at creation time. There is deliberately no separate mid-level
  // field: the hierarchy is arbitrary-depth, not a fixed two-tier
  // Scheme->Head split, so "deepest selected node" is the one fact that
  // matters for both the required and optional cases.
  headId: Types.ObjectId | null;
  requireHeadAtCreation: boolean;
  amount: number;
  sourcePools: BudgetAllocationSourcePool[];
  // ---- GLOBAL FINANCIAL APPROVAL WORKFLOW (Maker/Verifier/Checker) ----
  // The workflow applies per the ALLOCATION's specific target Organization
  // Node (organizationNodeId — e.g. "BAEG"), not the scope's root, since
  // Maker/Verifier/Checker are assigned per node and a bulk submission can
  // target several different departments with different configurations in
  // one go — each row resolves and snapshots its own workflow independently.
  // The `sourcePools` reservation above already happens atomically at Maker
  // submission (that's what "Holding" means here — the money is genuinely
  // set aside the instant it's created, never a soft/advisory hold); verify
  // and approve only relabel holdingAmount/approvedAmount/transferredAmount
  // on this record, they never touch sourcePools again. Only reject calls
  // releaseBudgetAmount to actually give the money back.
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
  remarks: string | null;
  // A Reference Document uploaded for the bulk batch this row was created
  // in gets copied onto every row of that batch (there is no separate
  // "batch" entity to hang a single shared attachment off of), so each
  // allocation record can still show/download its supporting document on
  // its own.
  attachments: Types.DocumentArray<BudgetAllocationAttachment>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const budgetAllocationAttachmentSchema = new Schema<BudgetAllocationAttachment>(
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

const budgetAllocationSourcePoolSchema = new Schema<BudgetAllocationSourcePool>(
  {
    budgetSetupId: { type: Schema.Types.ObjectId, ref: "BudgetSetup", required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const budgetAllocationSchema = new Schema<BudgetAllocationDocument>(
  {
    financialYearId: { type: Schema.Types.ObjectId, ref: "FinancialYear", required: true },
    organizationRootNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    schemeHeadRootNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    // The specific Head chosen within the scheme hierarchy — nullable when
    // Require Head was OFF at creation time.
    headId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", default: null },
    requireHeadAtCreation: { type: Boolean, required: true },
    amount: { type: Number, required: true, min: 1 },
    sourcePools: { type: [budgetAllocationSourcePoolSchema], required: true, default: [] },
    // Defaults to APPROVED (see BudgetSetup model for the same reasoning) —
    // allocations created before this workflow existed already moved real
    // money via sourcePools, so they behave as already-approved rather than
    // silently reappearing as "pending" once this ships.
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
    remarks: { type: String, trim: true, maxlength: 1000, default: null },
    attachments: { type: [budgetAllocationAttachmentSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

budgetAllocationSchema.index({ "sourcePools.budgetSetupId": 1 });
budgetAllocationSchema.index({ organizationRootNodeId: 1, schemeHeadRootNodeId: 1, financialYearId: 1 });
budgetAllocationSchema.index({ organizationNodeId: 1 });
budgetAllocationSchema.index({ headId: 1 });
budgetAllocationSchema.index({ financialYearId: 1 });
budgetAllocationSchema.index({ approvalStatus: 1 });
budgetAllocationSchema.index({ createdAt: -1 });

export const BudgetAllocationModel = model<BudgetAllocationDocument>(
  "BudgetAllocation",
  budgetAllocationSchema
);
