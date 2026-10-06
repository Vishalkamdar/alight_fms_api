import { Schema, model, Document, Types } from "mongoose";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";

export const PAYROLL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export type PayrollMonth = (typeof PAYROLL_MONTHS)[number];

/**
 * Same payment lifecycle shape as Expenditure, reused at both the batch
 * level (derived from the employee lines once payment runs) and on each
 * individual employee line (§30/§31 — each employee has its own payment/
 * reference information while remaining linked to the parent batch).
 */
export const PAYROLL_PAYMENT_STATUSES = [
  "PENDING_APPROVAL",
  "APPROVED",
  "PAYMENT_PENDING",
  "PAYMENT_PROCESSING",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILED",
] as const;
export type PayrollPaymentStatus = (typeof PAYROLL_PAYMENT_STATUSES)[number];

/**
 * Frozen at submission time, same reasoning as ExpenditureDeductionSnapshot
 * — a later change to the Employee Deduction Master must never reinterpret
 * an already-submitted payroll line (§36).
 */
export interface PayrollDeductionSnapshot {
  deductionId: Types.ObjectId;
  deductionName: string;
  deductionType: "EMPLOYEE";
  calculationType: "PERCENTAGE" | "FIXED_AMOUNT";
  percentage: number | null;
  fixedAmount: number | null;
  calculatedAmount: number;
}

/** Same shape as ExpenditureBankSnapshot — captured at payment-initiation time, not submission (§21). */
export interface PayrollBankSnapshot {
  bankName: string;
  accountHolderName: string;
  maskedAccountNumber: string;
  ifscCode: string;
  beneficiaryId: Types.ObjectId;
}

export interface PayrollLine {
  _id: Types.ObjectId;
  beneficiaryId: Types.ObjectId;
  beneficiarySnapshot: { name: string; employeeId: string | null; panNumber: string | null };
  salaryAmount: number;
  deductions: PayrollDeductionSnapshot[];
  totalDeduction: number;
  netSalary: number;
  paymentStatus: PayrollPaymentStatus;
  paymentReference: string | null;
  bankSnapshot: PayrollBankSnapshot | null;
  paymentFailureReason: string | null;
  paymentInitiatedAt: Date | null;
  paymentCompletedAt: Date | null;
}

export interface PayrollSourcePool {
  kind: "BUDGET_ALLOCATION" | "FUND_TRANSFER";
  poolId: Types.ObjectId;
  amount: number;
}

export interface PayrollAttachment {
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

/**
 * One payroll run for a (Financial Year, root Scheme, Organization Node,
 * Month) period — a real parent batch with embedded per-employee lines
 * (§19), unlike Budget Allocation's bulk-create (N independent sibling
 * documents, no shared parent — see that model's own comment). The whole
 * batch is approved/rejected/paid as one unit; only the payment step fans
 * out per employee line, each with its own reference/snapshot/status.
 */
export interface PayrollBatchDocument extends Document {
  _id: Types.ObjectId;
  payrollNumber: string;
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  beneficiaryType: "EMPLOYEE";
  month: PayrollMonth;
  sanctionNumber: string | null;
  sanctionDate: Date | null;
  remarks: string | null;
  enrichment1: string | null;
  enrichment2: string | null;

  employees: Types.DocumentArray<PayrollLine>;
  totalGrossSalary: number;
  totalDeduction: number;
  totalNetSalary: number;

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
  sourcePools: PayrollSourcePool[];

  paymentStatus: PayrollPaymentStatus;

  attachments: Types.DocumentArray<PayrollAttachment>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const deductionSnapshotSchema = new Schema<PayrollDeductionSnapshot>(
  {
    deductionId: { type: Schema.Types.ObjectId, ref: "DeductionMaster", required: true },
    deductionName: { type: String, required: true },
    deductionType: { type: String, enum: ["EMPLOYEE"], required: true },
    calculationType: { type: String, enum: ["PERCENTAGE", "FIXED_AMOUNT"], required: true },
    percentage: { type: Number, default: null },
    fixedAmount: { type: Number, default: null },
    calculatedAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const bankSnapshotSchema = new Schema<PayrollBankSnapshot>(
  {
    bankName: { type: String, required: true },
    accountHolderName: { type: String, required: true },
    maskedAccountNumber: { type: String, required: true },
    ifscCode: { type: String, required: true },
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "Beneficiary", required: true },
  },
  { _id: false }
);

const payrollLineSchema = new Schema<PayrollLine>(
  {
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "Beneficiary", required: true },
    beneficiarySnapshot: {
      type: {
        name: { type: String, required: true },
        employeeId: { type: String, default: null },
        panNumber: { type: String, default: null },
      },
      required: true,
      _id: false,
    },
    salaryAmount: { type: Number, required: true, min: 0.01 },
    deductions: { type: [deductionSnapshotSchema], default: [] },
    totalDeduction: { type: Number, required: true, default: 0, min: 0 },
    netSalary: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: PAYROLL_PAYMENT_STATUSES, default: "PENDING_APPROVAL" },
    paymentReference: { type: String, default: null },
    bankSnapshot: { type: bankSnapshotSchema, default: null },
    paymentFailureReason: { type: String, trim: true, maxlength: 1000, default: null },
    paymentInitiatedAt: { type: Date, default: null },
    paymentCompletedAt: { type: Date, default: null },
  },
  { _id: true }
);

const sourcePoolSchema = new Schema<PayrollSourcePool>(
  {
    kind: { type: String, enum: ["BUDGET_ALLOCATION", "FUND_TRANSFER"], required: true },
    poolId: { type: Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const attachmentSchema = new Schema<PayrollAttachment>(
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

const payrollBatchSchema = new Schema<PayrollBatchDocument>(
  {
    payrollNumber: { type: String, required: true, unique: true, trim: true },
    financialYearId: { type: Schema.Types.ObjectId, ref: "FinancialYear", required: true },
    organizationRootNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", required: true },
    schemeHeadRootNodeId: { type: Schema.Types.ObjectId, ref: "SchemeHeadNode", required: true },
    beneficiaryType: { type: String, enum: ["EMPLOYEE"], required: true, default: "EMPLOYEE" },
    month: { type: String, enum: PAYROLL_MONTHS, required: true },
    sanctionNumber: { type: String, trim: true, maxlength: 60, default: null },
    sanctionDate: { type: Date, default: null },
    remarks: { type: String, trim: true, maxlength: 1000, default: null },
    enrichment1: { type: String, trim: true, maxlength: 200, default: null },
    enrichment2: { type: String, trim: true, maxlength: 200, default: null },

    employees: { type: [payrollLineSchema], required: true, validate: [(v: unknown[]) => v.length > 0, "At least one Employee is required."] },
    totalGrossSalary: { type: Number, required: true, min: 0.01 },
    totalDeduction: { type: Number, required: true, default: 0, min: 0 },
    totalNetSalary: { type: Number, required: true, min: 0 },

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

    paymentStatus: { type: String, enum: PAYROLL_PAYMENT_STATUSES, default: "PENDING_APPROVAL" },

    attachments: { type: [attachmentSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// §37 — no duplicate payroll batch for the same period/scope; paired with
// an application-level findOne pre-check in payroll.service.ts for a
// friendly 409 (same convention as DeductionMaster/FinancialYear/
// FmsNodeRoleConfig, not BudgetSetup's deliberately-non-unique index).
payrollBatchSchema.index({ financialYearId: 1, organizationNodeId: 1, schemeHeadRootNodeId: 1, month: 1 }, { unique: true });
payrollBatchSchema.index({ "sourcePools.poolId": 1 });
payrollBatchSchema.index({ organizationRootNodeId: 1, schemeHeadRootNodeId: 1, financialYearId: 1 });
payrollBatchSchema.index({ organizationNodeId: 1 });
payrollBatchSchema.index({ "employees.beneficiaryId": 1 });
payrollBatchSchema.index({ approvalStatus: 1 });
payrollBatchSchema.index({ paymentStatus: 1 });
payrollBatchSchema.index({ createdAt: -1 });

export const PayrollBatchModel = model<PayrollBatchDocument>("PayrollBatch", payrollBatchSchema);
