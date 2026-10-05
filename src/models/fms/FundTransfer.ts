import { Schema, model, Document, Types } from "mongoose";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";

/**
 * Two business actions, same financial effect (money moves from a child
 * node up to its immediate parent) and the same ledger shape — kept as one
 * collection with a `transactionType` discriminator (per the spec's own
 * "maintain a clear transaction type in the database" instruction) while
 * the API routes, permission checks, and frontend pages for each stay
 * completely separate:
 *  - PULL_FROM_CHILD: the PARENT (upper level) initiates, pulling unused
 *    funds back from its immediate child. Maker permission is checked
 *    against destinationNodeId (the parent).
 *  - RETURN_TO_PARENT: the CHILD (lower level) initiates, voluntarily
 *    returning unused funds to its immediate parent. Maker permission is
 *    checked against sourceNodeId (the child).
 * Either way sourceNodeId is always the child (money decreases there) and
 * destinationNodeId is always the parent (money increases there) — this is
 * NEVER an edit to the original BudgetAllocation record, only a new,
 * separate ledger entry referencing it for context.
 */
export const FUND_TRANSFER_TYPES = ["PULL_FROM_CHILD", "RETURN_TO_PARENT"] as const;
export type FundTransferType = (typeof FUND_TRANSFER_TYPES)[number];

export interface FundTransferDocument extends Document {
  _id: Types.ObjectId;
  transactionType: FundTransferType;
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  headId: Types.ObjectId | null;
  // Always the child (returnable balance decreases) / always the parent
  // (available balance increases), regardless of transactionType — see the
  // module doc comment above. Validated server-side as an actual immediate
  // parent/child pair in the Organization Tree; never trusted from the
  // client as an arbitrary pair.
  sourceNodeId: Types.ObjectId;
  destinationNodeId: Types.ObjectId;
  amount: number;
  reason: string;
  relatedBudgetAllocationId: Types.ObjectId | null;
  // How much of this record's own `amount` has, once APPROVED, been drawn
  // by the destination node's own further outgoing commitments (sub-
  // allocating onward to its children, or itself pulling/returning further
  // up) — the same shared-capacity-counter pattern as BudgetAllocation's
  // own subAllocatedAmount, making a FundTransfer's destination just as
  // "poolable" for further use as a direct Budget Allocation receipt.
  subAllocatedAmount: number;
  // ---- GLOBAL FINANCIAL APPROVAL WORKFLOW (Maker/Verifier/Checker) ----
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
  // Exactly which of the source node's own received pools (Budget
  // Allocation and/or an earlier Fund Transfer it received) this
  // transaction's Holding was actually drawn from — the audit trail
  // needed to release the right amount back to the right place on reject.
  sourcePools: Array<{ kind: "BUDGET_ALLOCATION" | "FUND_TRANSFER"; poolId: Types.ObjectId; amount: number }>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fundTransferSourcePoolSchema = new Schema(
  {
    kind: { type: String, enum: ["BUDGET_ALLOCATION", "FUND_TRANSFER"], required: true },
    poolId: { type: Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const fundTransferSchema = new Schema<FundTransferDocument>(
  {
    transactionType: { type: String, enum: FUND_TRANSFER_TYPES, required: true },
    financialYearId: { type: Schema.Types.ObjectId, ref: "FinancialYear", required: true },
    organizationRootNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    schemeHeadRootNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    headId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", default: null },
    sourceNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    destinationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, minlength: 1, maxlength: 1000 },
    relatedBudgetAllocationId: { type: Schema.Types.ObjectId, ref: "BudgetAllocation", default: null },
    subAllocatedAmount: { type: Number, required: true, default: 0, min: 0 },
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, default: "PENDING_VERIFICATION" },
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
    sourcePools: { type: [fundTransferSourcePoolSchema], required: true, default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

fundTransferSchema.index({ organizationRootNodeId: 1, schemeHeadRootNodeId: 1, financialYearId: 1 });
fundTransferSchema.index({ sourceNodeId: 1 });
fundTransferSchema.index({ destinationNodeId: 1 });
fundTransferSchema.index({ transactionType: 1 });
fundTransferSchema.index({ approvalStatus: 1 });
fundTransferSchema.index({ createdAt: -1 });
fundTransferSchema.index({ "sourcePools.poolId": 1 });

export const FundTransferModel = model<FundTransferDocument>("FundTransfer", fundTransferSchema);
