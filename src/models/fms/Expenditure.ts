import { Schema, model, Document, Types } from "mongoose";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";
import type { BeneficiaryType } from "./Beneficiary";

export const EXPENDITURE_PAYMENT_TYPES = ["ONLINE", "CASH"] as const;
export type ExpenditurePaymentType = (typeof EXPENDITURE_PAYMENT_TYPES)[number];

/**
 * Distinct from `approvalStatus` — financial approval and actual bank
 * transfer are never the same event (§17). A record can sit at `APPROVED`
 * indefinitely if the payment step itself fails; `approvalStatus` never
 * reverses once APPROVED, only `paymentStatus` tracks the transfer attempt.
 */
export const EXPENDITURE_PAYMENT_STATUSES = [
  "PENDING_APPROVAL",
  "APPROVED",
  "PAYMENT_PENDING",
  "PAYMENT_PROCESSING",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILED",
] as const;
export type ExpenditurePaymentStatus = (typeof EXPENDITURE_PAYMENT_STATUSES)[number];

export interface ExpenditureParticular {
  description: string;
  amount: number;
}

/**
 * What a selected Vendor deduction actually applied — frozen at the moment
 * it was calculated so a later Deduction Master rename/deactivation/
 * percentage change can never reinterpret a historical Expenditure (§24,
 * matching Deduction Master's own documented intent). Always empty for an
 * Employee expenditure — Employee deductions (EPF/ESI/PT/LWF/...) are
 * reserved for the future Payroll module and must never appear here (§9).
 */
export interface ExpenditureDeductionSnapshot {
  deductionId: Types.ObjectId;
  deductionName: string;
  deductionType: "VENDOR";
  calculationType: "PERCENTAGE" | "FIXED_AMOUNT";
  percentage: number | null;
  fixedAmount: number | null;
  calculatedAmount: number;
}

/** Mirrors BudgetAllocation's ReceivedPoolReservation shape — what funded this expenditure's reservation from the node's own received pool. */
export interface ExpenditureSourcePool {
  kind: "BUDGET_ALLOCATION" | "FUND_TRANSFER";
  poolId: Types.ObjectId;
  amount: number;
}

/**
 * Captured once, at the moment payment is actually initiated (never at
 * creation) — the beneficiary's default bank account can change between
 * submission and final approval; the record must keep showing whichever
 * account the money actually went to (§19).
 */
export interface ExpenditureBankSnapshot {
  bankName: string;
  accountHolderName: string;
  maskedAccountNumber: string;
  ifscCode: string;
  beneficiaryId: Types.ObjectId;
}

export interface ExpenditureAttachment {
  _id: Types.ObjectId;
  documentInfo: string | null;
  fileName: string;
  originalName: string;
  fileUrl: string;
  mimeType: string;
  size: number;
  uploadedBy: Types.ObjectId | null;
  uploadedAt: Date;
}

export interface ExpenditureDocument extends Document {
  _id: Types.ObjectId;
  // ---- Scope (identical pattern to BudgetAllocation/FundTransfer) ----
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  headId: Types.ObjectId;
  // ---- Beneficiary ----
  beneficiaryType: BeneficiaryType;
  beneficiaryId: Types.ObjectId;
  beneficiarySnapshot: { name: string; beneficiaryType: BeneficiaryType; panNumber: string | null; gstNumber: string | null };
  paymentType: ExpenditurePaymentType;
  // ---- Basic Details ----
  billVoucherNumber: string;
  billVoucherDate: Date;
  debitNarration: string | null;
  creditNarration: string | null;
  remarks: string | null;
  enrichment1: string | null;
  enrichment2: string | null;
  // ---- Particulars / amounts (all server-recomputed, never trusted from the client — §10/§11) ----
  particulars: ExpenditureParticular[];
  grossAmount: number;
  cgstPercent: number;
  cgstAmount: number;
  sgstPercent: number;
  sgstAmount: number;
  igstPercent: number;
  igstAmount: number;
  totalWithTax: number;
  deductions: ExpenditureDeductionSnapshot[];
  totalDeduction: number;
  netPayableAmount: number;
  // ---- GLOBAL FINANCIAL APPROVAL WORKFLOW (Maker/Verifier/Checker) ----
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: Types.ObjectId;
  verifierId: Types.ObjectId | null;
  checkerId: Types.ObjectId | null;
  holdingAmount: number;
  approvedAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: Types.ObjectId | null;
  rejectedAt: Date | null;
  sourcePools: ExpenditureSourcePool[];
  // ---- Payment (§16-19) ----
  paymentStatus: ExpenditurePaymentStatus;
  paymentReference: string | null;
  bankSnapshot: ExpenditureBankSnapshot | null;
  paymentFailureReason: string | null;
  paymentInitiatedAt: Date | null;
  paymentCompletedAt: Date | null;
  // ---- Documents ----
  attachments: Types.DocumentArray<ExpenditureAttachment>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const particularSchema = new Schema<ExpenditureParticular>(
  {
    description: { type: String, required: true, trim: true, maxlength: 300 },
    amount: { type: Number, required: true, min: 0.01 },
  },
  { _id: false }
);

const deductionSnapshotSchema = new Schema<ExpenditureDeductionSnapshot>(
  {
    deductionId: { type: Schema.Types.ObjectId, ref: "DeductionMaster", required: true },
    deductionName: { type: String, required: true },
    deductionType: { type: String, enum: ["VENDOR"], required: true },
    calculationType: { type: String, enum: ["PERCENTAGE", "FIXED_AMOUNT"], required: true },
    percentage: { type: Number, default: null },
    fixedAmount: { type: Number, default: null },
    calculatedAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const sourcePoolSchema = new Schema<ExpenditureSourcePool>(
  {
    kind: { type: String, enum: ["BUDGET_ALLOCATION", "FUND_TRANSFER"], required: true },
    poolId: { type: Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const bankSnapshotSchema = new Schema<ExpenditureBankSnapshot>(
  {
    bankName: { type: String, required: true },
    accountHolderName: { type: String, required: true },
    maskedAccountNumber: { type: String, required: true },
    ifscCode: { type: String, required: true },
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "Beneficiary", required: true },
  },
  { _id: false }
);

const attachmentSchema = new Schema<ExpenditureAttachment>(
  {
    documentInfo: { type: String, trim: true, maxlength: 300, default: null },
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

const expenditureSchema = new Schema<ExpenditureDocument>(
  {
    financialYearId: { type: Schema.Types.ObjectId, ref: "FinancialYear", required: true },
    organizationRootNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    schemeHeadRootNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    headId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },

    beneficiaryType: { type: String, enum: ["VENDOR", "EMPLOYEE"], required: true },
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "Beneficiary", required: true },
    beneficiarySnapshot: {
      type: {
        name: { type: String, required: true },
        beneficiaryType: { type: String, enum: ["VENDOR", "EMPLOYEE"], required: true },
        panNumber: { type: String, default: null },
        gstNumber: { type: String, default: null },
      },
      required: true,
      _id: false,
    },
    paymentType: { type: String, enum: ["ONLINE", "CASH"], required: true },

    billVoucherNumber: { type: String, required: true, trim: true, maxlength: 60 },
    billVoucherDate: { type: Date, required: true },
    debitNarration: { type: String, trim: true, maxlength: 500, default: null },
    creditNarration: { type: String, trim: true, maxlength: 500, default: null },
    remarks: { type: String, trim: true, maxlength: 1000, default: null },
    enrichment1: { type: String, trim: true, maxlength: 200, default: null },
    enrichment2: { type: String, trim: true, maxlength: 200, default: null },

    particulars: { type: [particularSchema], required: true, validate: [(v: unknown[]) => v.length > 0, "At least one Particular is required."] },
    grossAmount: { type: Number, required: true, min: 0.01 },
    cgstPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    cgstAmount: { type: Number, required: true, default: 0, min: 0 },
    sgstPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    sgstAmount: { type: Number, required: true, default: 0, min: 0 },
    igstPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    igstAmount: { type: Number, required: true, default: 0, min: 0 },
    totalWithTax: { type: Number, required: true, min: 0.01 },
    deductions: { type: [deductionSnapshotSchema], default: [] },
    totalDeduction: { type: Number, required: true, default: 0, min: 0 },
    netPayableAmount: { type: Number, required: true, min: 0 },

    approvalStatus: { type: String, enum: APPROVAL_STATUSES, default: "PENDING_VERIFICATION" },
    workflowSnapshot: {
      type: {
        makerRequired: { type: Boolean, required: true },
        verifierRequired: { type: Boolean, required: true },
        checkerRequired: { type: Boolean, required: true },
      },
      required: true,
      _id: false,
    },
    makerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    verifierId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    checkerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    holdingAmount: { type: Number, required: true, default: 0, min: 0 },
    approvedAmount: { type: Number, required: true, default: 0, min: 0 },
    verifiedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt: { type: Date, default: null },
    sourcePools: { type: [sourcePoolSchema], required: true, default: [] },

    paymentStatus: { type: String, enum: EXPENDITURE_PAYMENT_STATUSES, default: "PENDING_APPROVAL" },
    paymentReference: { type: String, default: null },
    bankSnapshot: { type: bankSnapshotSchema, default: null },
    paymentFailureReason: { type: String, trim: true, maxlength: 1000, default: null },
    paymentInitiatedAt: { type: Date, default: null },
    paymentCompletedAt: { type: Date, default: null },

    attachments: { type: [attachmentSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

expenditureSchema.index({ "sourcePools.poolId": 1 });
expenditureSchema.index({ organizationRootNodeId: 1, schemeHeadRootNodeId: 1, financialYearId: 1 });
expenditureSchema.index({ organizationNodeId: 1 });
expenditureSchema.index({ beneficiaryId: 1 });
expenditureSchema.index({ headId: 1 });
expenditureSchema.index({ financialYearId: 1 });
expenditureSchema.index({ approvalStatus: 1 });
expenditureSchema.index({ paymentStatus: 1 });
expenditureSchema.index({ paymentReference: 1 });
expenditureSchema.index({ createdAt: -1 });

export const ExpenditureModel = model<ExpenditureDocument>("Expenditure", expenditureSchema);
