import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { uploadToBlob } from "../../utils/fms/blob-storage";
import {
  PayrollBatchModel,
  type PayrollBatchDocument,
  type PayrollLine,
  type PayrollDeductionSnapshot,
  type PayrollMonth,
} from "../../models/fms/PayrollBatch";
import { BeneficiaryModel } from "../../models/fms/Beneficiary";
import { DeductionMasterModel } from "../../models/fms/DeductionMaster";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import { UserModel, type UserRole } from "../../models/User";
import { assertFinancialYearIsWritable } from "./financial-year.service";
import {
  assertRootOrganizationNode,
  assertRootSchemeHeadNode,
  isOrganizationNodeSelfOrDescendant,
  reserveFromNodeOwnReceivedPool,
  releaseToParentPool,
  type ReceivedPoolReservation,
} from "./budget-allocation.service";
import {
  assertMakerPermission,
  assertVerifierPermission,
  assertCheckerPermission,
  assertNotSelfApproving,
  computeVerifyTransition,
  resolveWorkflowForNode,
  recordWorkflowEvent,
  getMyActionableNodeIds,
  getAllowedNodeIdsForList,
  type ApprovalStatus,
  type WorkflowSnapshot,
  type ActorForPermission,
} from "./financial-workflow.service";
import { paymentTransferProvider, generatePaymentReference } from "./payment-transfer.service";
import type { FmsRole } from "../../models/fms/FmsUserNodeRole";
import type { CreatePayrollBatchInput, PayrollExportQuery, PayrollListQuery } from "../../schemas/fms/payroll.schema";

interface ActorContext {
  actorId: Types.ObjectId | null;
  actorRole?: UserRole;
  allowedNodeIds?: string[] | null;
  ipAddress: string | null;
  userAgent?: string | null;
}

function requireActorId(context: ActorContext): Types.ObjectId {
  if (!context.actorId) throw new AppError(401, "Authentication required.");
  return context.actorId;
}
function requireActorRole(context: ActorContext): UserRole {
  if (!context.actorRole) throw new AppError(401, "Authentication required.");
  return context.actorRole;
}
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4 ? `••${accountNumber.slice(-4)}` : accountNumber;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

interface NodeRef {
  _id: string;
  name: string;
}
interface FinancialYearRef {
  _id: string;
  financialYear: string;
}
interface UserRef {
  _id: string;
  fullname: string;
}

export interface PayrollLineDto {
  _id: string;
  beneficiaryId: string;
  beneficiarySnapshot: { name: string; employeeId: string | null; panNumber: string | null };
  salaryAmount: number;
  deductions: PayrollDeductionSnapshot[];
  totalDeduction: number;
  netSalary: number;
  approvalStatus: ApprovalStatus;
  verifierId: string | null;
  verifier: UserRef | null;
  checkerId: string | null;
  checker: UserRef | null;
  holdingAmount: number;
  approvedAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  paymentStatus: string;
  paymentReference: string | null;
  bankSnapshot: { bankName: string; accountHolderName: string; maskedAccountNumber: string; ifscCode: string } | null;
  paymentFailureReason: string | null;
  paymentInitiatedAt: Date | null;
  paymentCompletedAt: Date | null;
}

export interface PayrollBatchDto {
  _id: string;
  payrollNumber: string;
  financialYearId: string;
  financialYear: FinancialYearRef | null;
  organizationRootNodeId: string;
  organizationNodeId: string;
  organizationNode: NodeRef | null;
  schemeHeadRootNodeId: string;
  schemeHeadRoot: NodeRef | null;
  beneficiaryType: "EMPLOYEE";
  month: PayrollMonth;
  sanctionNumber: string | null;
  sanctionDate: Date | null;
  remarks: string | null;
  enrichment1: string | null;
  enrichment2: string | null;
  employees: PayrollLineDto[];
  employeeCount: number;
  totalGrossSalary: number;
  totalDeduction: number;
  totalNetSalary: number;
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: string;
  maker: UserRef | null;
  verifierId: string | null;
  verifier: UserRef | null;
  checkerId: string | null;
  holdingAmount: number;
  approvedAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  hasRejectedLines: boolean;
  rejectedLineCount: number;
  paymentStatus: string;
  attachments: Array<{ _id: string; documentInfo: string | null; originalName: string; fileUrl: string; mimeType: string; size: number; uploadedAt: Date }>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

async function buildLookupMaps() {
  const [orgNodes, schemeHeadNodes, financialYears, users] = await Promise.all([
    OrganizationNodeModel.find().select("name").lean(),
    SchemeHeadNodeModel.find().select("name").lean(),
    FinancialYearModel.find().select("financialYear").lean(),
    UserModel.find().select("fullname").lean(),
  ]);
  return {
    orgNodeMap: new Map<string, NodeRef>(orgNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])),
    schemeHeadNodeMap: new Map<string, NodeRef>(schemeHeadNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])),
    financialYearMap: new Map<string, FinancialYearRef>(financialYears.map((y) => [String(y._id), { _id: String(y._id), financialYear: y.financialYear }])),
    userMap: new Map<string, UserRef>(users.map((u) => [String(u._id), { _id: String(u._id), fullname: u.fullname }])),
  };
}

function serializeLine(line: PayrollLine, userMap: Map<string, UserRef>): PayrollLineDto {
  const verifierId = line.verifierId ? String(line.verifierId) : null;
  const checkerId = line.checkerId ? String(line.checkerId) : null;
  return {
    _id: String(line._id),
    beneficiaryId: String(line.beneficiaryId),
    beneficiarySnapshot: line.beneficiarySnapshot,
    salaryAmount: line.salaryAmount,
    deductions: line.deductions,
    totalDeduction: line.totalDeduction,
    netSalary: line.netSalary,
    approvalStatus: line.approvalStatus,
    verifierId,
    verifier: verifierId ? (userMap.get(verifierId) ?? null) : null,
    checkerId,
    checker: checkerId ? (userMap.get(checkerId) ?? null) : null,
    holdingAmount: line.holdingAmount,
    approvedAmount: line.approvedAmount,
    verifiedAt: line.verifiedAt,
    approvedAt: line.approvedAt,
    rejectionReason: line.rejectionReason,
    rejectedBy: line.rejectedBy ? String(line.rejectedBy) : null,
    rejectedAt: line.rejectedAt,
    paymentStatus: line.paymentStatus,
    paymentReference: line.paymentReference,
    bankSnapshot: line.bankSnapshot
      ? {
          bankName: line.bankSnapshot.bankName,
          accountHolderName: line.bankSnapshot.accountHolderName,
          maskedAccountNumber: line.bankSnapshot.maskedAccountNumber,
          ifscCode: line.bankSnapshot.ifscCode,
        }
      : null,
    paymentFailureReason: line.paymentFailureReason,
    paymentInitiatedAt: line.paymentInitiatedAt,
    paymentCompletedAt: line.paymentCompletedAt,
  };
}

function serialize(doc: PayrollBatchDocument, maps: Awaited<ReturnType<typeof buildLookupMaps>>): PayrollBatchDto {
  const financialYearId = String(doc.financialYearId);
  const organizationNodeId = String(doc.organizationNodeId);
  const schemeHeadRootNodeId = String(doc.schemeHeadRootNodeId);
  const makerId = String(doc.makerId);
  const verifierId = doc.verifierId ? String(doc.verifierId) : null;

  return {
    _id: String(doc._id),
    payrollNumber: doc.payrollNumber,
    financialYearId,
    financialYear: maps.financialYearMap.get(financialYearId) ?? null,
    organizationRootNodeId: String(doc.organizationRootNodeId),
    organizationNodeId,
    organizationNode: maps.orgNodeMap.get(organizationNodeId) ?? null,
    schemeHeadRootNodeId,
    schemeHeadRoot: maps.schemeHeadNodeMap.get(schemeHeadRootNodeId) ?? null,
    beneficiaryType: doc.beneficiaryType,
    month: doc.month,
    sanctionNumber: doc.sanctionNumber,
    sanctionDate: doc.sanctionDate,
    remarks: doc.remarks,
    enrichment1: doc.enrichment1,
    enrichment2: doc.enrichment2,
    employees: doc.employees.map((line) => serializeLine(line, maps.userMap)),
    employeeCount: doc.employees.length,
    totalGrossSalary: doc.totalGrossSalary,
    totalDeduction: doc.totalDeduction,
    totalNetSalary: doc.totalNetSalary,
    approvalStatus: doc.approvalStatus,
    workflowSnapshot: doc.workflowSnapshot,
    makerId,
    maker: maps.userMap.get(makerId) ?? null,
    verifierId,
    verifier: verifierId ? (maps.userMap.get(verifierId) ?? null) : null,
    checkerId: doc.checkerId ? String(doc.checkerId) : null,
    holdingAmount: doc.holdingAmount,
    approvedAmount: doc.approvedAmount,
    verifiedAt: doc.verifiedAt,
    approvedAt: doc.approvedAt,
    rejectionReason: doc.rejectionReason,
    rejectedBy: doc.rejectedBy ? String(doc.rejectedBy) : null,
    rejectedAt: doc.rejectedAt,
    hasRejectedLines: doc.hasRejectedLines,
    rejectedLineCount: doc.rejectedLineCount,
    paymentStatus: doc.paymentStatus,
    attachments: doc.attachments.map((a) => ({
      _id: String(a._id),
      documentInfo: a.documentInfo,
      originalName: a.originalName,
      fileUrl: a.fileUrl,
      mimeType: a.mimeType,
      size: a.size,
      uploadedAt: a.uploadedAt,
    })),
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Scope / duplicate-period / employee-line validation
// ---------------------------------------------------------------------------

interface ValidatedScope {
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
}

async function validateScope(input: {
  financialYearId: string;
  organizationRootNodeId: string;
  organizationNodeId: string;
  schemeHeadRootNodeId: string;
}): Promise<ValidatedScope> {
  await assertFinancialYearIsWritable(input.financialYearId);
  await assertRootOrganizationNode(input.organizationRootNodeId);
  await assertRootSchemeHeadNode(input.schemeHeadRootNodeId);

  const orgNode = await OrganizationNodeModel.findById(input.organizationNodeId);
  if (!orgNode) throw new AppError(422, "The selected Organization Node does not exist.", { organizationNodeId: ["Not found."] });
  if (orgNode.status !== "Active") throw new AppError(422, "The selected Organization Node is inactive.", { organizationNodeId: ["Must be active."] });
  const orgInScope = await isOrganizationNodeSelfOrDescendant(input.organizationNodeId, input.organizationRootNodeId);
  if (!orgInScope) {
    throw new AppError(422, "The selected Organization Node does not belong to this scope's Organization hierarchy.", {
      organizationNodeId: ["Node must be under the selected root Organization Node."],
    });
  }

  return {
    financialYearId: new Types.ObjectId(input.financialYearId),
    organizationRootNodeId: new Types.ObjectId(input.organizationRootNodeId),
    organizationNodeId: new Types.ObjectId(input.organizationNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(input.schemeHeadRootNodeId),
  };
}

/** §37 — findOne pre-check (friendly 409), paired with the model's own unique index as the DB-level backstop. */
async function assertNoDuplicatePayrollPeriod(scope: ValidatedScope, month: PayrollMonth, excludeId?: string): Promise<void> {
  const match: Record<string, unknown> = {
    financialYearId: scope.financialYearId,
    organizationNodeId: scope.organizationNodeId,
    schemeHeadRootNodeId: scope.schemeHeadRootNodeId,
    month,
  };
  if (excludeId) match._id = { $ne: excludeId };
  const existing = await PayrollBatchModel.findOne(match).select("payrollNumber");
  if (existing) {
    throw new AppError(409, `A Payroll batch for ${month} already exists for this Financial Year, Scheme, and Organization Node ("${existing.payrollNumber}").`, {
      month: ["A Payroll batch already exists for this period."],
    });
  }
}

/** §11/§38 — must be an Active Employee beneficiary with a default bank account (Payroll is online-only). */
async function validateEmployeeBeneficiary(beneficiaryId: string) {
  const beneficiary = await BeneficiaryModel.findById(beneficiaryId);
  if (!beneficiary) throw new AppError(422, "A selected Employee does not exist.", { beneficiaryId: ["Not found."] });
  if (!beneficiary.isActive) throw new AppError(422, `"${beneficiary.name}" is not an active Employee.`, { beneficiaryId: ["Must be active."] });
  if (beneficiary.beneficiaryType !== "EMPLOYEE") {
    throw new AppError(422, `"${beneficiary.name}" is not an Employee beneficiary.`, { beneficiaryId: ["Only Employee beneficiaries are allowed in Payroll."] });
  }
  const defaultBank = beneficiary.bankAccounts.find((b) => b.isDefault) ?? null;
  if (!defaultBank) {
    throw new AppError(422, `"${beneficiary.name}" has no Default Bank Account on file — required for Payroll.`, {
      beneficiaryId: ["Add a default bank account in Beneficiary Master first."],
    });
  }
  return beneficiary;
}

/**
 * Resolves one employee's submitted deductions against the live Employee
 * Deduction Master — Active + EMPLOYEE type only (never Vendor, never
 * inactive, never invented — §12/§38), same defense-in-depth split applied
 * to Expenditure's Vendor deductions: the per-cell Rs. amount itself is
 * trusted (Maker-editable, necessary for variable deductions like Loan
 * Installment/Advance that a single master-wide default can't represent),
 * but the deductionId's validity is always re-verified.
 */
async function resolvePayrollLineDeductions(
  salaryAmount: number,
  selections: Array<{ deductionId: string; percentage?: number; amount: number }>,
  deductionDocsById: Map<string, { _id: Types.ObjectId; name: string; calculationType: "PERCENTAGE" | "FIXED_AMOUNT" }>
): Promise<{ deductions: PayrollDeductionSnapshot[]; totalDeduction: number; netSalary: number }> {
  const deductions: PayrollDeductionSnapshot[] = selections.map((selection) => {
    const doc = deductionDocsById.get(selection.deductionId);
    if (!doc) {
      throw new AppError(422, "One or more selected deductions are invalid, inactive, or not an Employee deduction.", {
        deductions: ["Only Active Employee deductions may be selected."],
      });
    }
    const calculatedAmount = round2(selection.amount);
    return {
      deductionId: doc._id,
      deductionName: doc.name,
      deductionType: "EMPLOYEE",
      calculationType: doc.calculationType,
      percentage: selection.percentage ?? null,
      fixedAmount: calculatedAmount,
      calculatedAmount,
    };
  });
  const totalDeduction = round2(deductions.reduce((sum, d) => sum + d.calculatedAmount, 0));
  const netSalary = round2(salaryAmount - totalDeduction);
  if (netSalary < 0) {
    throw new AppError(422, "Total Deductions exceed the Salary Amount for one or more employees.", {
      deductions: ["Deductions exceed the employee's salary."],
    });
  }
  return { deductions, totalDeduction, netSalary };
}

// ---------------------------------------------------------------------------
// Per-employee approval rollup + payment (§21, §30-32)
// ---------------------------------------------------------------------------

/**
 * The batch's own approvalStatus/holdingAmount/approvedAmount/
 * hasRejectedLines/rejectedLineCount are a maintained ROLLUP over the
 * employee lines, recomputed after every line-level action — never set
 * directly. Precedence: any line still PENDING_VERIFICATION keeps the whole
 * batch at PENDING_VERIFICATION (so it keeps showing in the Verifier's
 * queue); else any line still PENDING_CHECKER_APPROVAL keeps it there;
 * else APPROVED if at least one line made it through; else (every line
 * terminal, none approved) REJECTED_BY_CHECKER/VERIFIER depending on which
 * stage the rejections happened at. Deliberately doesn't introduce a new
 * "partially approved" status value — hasRejectedLines/rejectedLineCount
 * carry that instead, without touching the shared ApprovalStatus enum 4
 * other modules trust to be exhaustive.
 */
function recomputeBatchRollup(doc: PayrollBatchDocument): void {
  const lines = doc.employees;
  const anyPendingVerification = lines.some((l) => l.approvalStatus === "PENDING_VERIFICATION");
  const anyPendingChecker = lines.some((l) => l.approvalStatus === "PENDING_CHECKER_APPROVAL");
  const approvedLines = lines.filter((l) => l.approvalStatus === "APPROVED");
  const rejectedLines = lines.filter((l) => l.approvalStatus === "REJECTED_BY_VERIFIER" || l.approvalStatus === "REJECTED_BY_CHECKER");

  if (anyPendingVerification) {
    doc.approvalStatus = "PENDING_VERIFICATION";
  } else if (anyPendingChecker) {
    doc.approvalStatus = "PENDING_CHECKER_APPROVAL";
  } else if (approvedLines.length > 0) {
    doc.approvalStatus = "APPROVED";
  } else {
    doc.approvalStatus = rejectedLines.some((l) => l.approvalStatus === "REJECTED_BY_CHECKER")
      ? "REJECTED_BY_CHECKER"
      : "REJECTED_BY_VERIFIER";
  }

  doc.holdingAmount = round2(lines.reduce((sum, l) => sum + l.holdingAmount, 0));
  doc.approvedAmount = round2(approvedLines.reduce((sum, l) => sum + l.approvedAmount, 0));
  doc.hasRejectedLines = rejectedLines.length > 0;
  doc.rejectedLineCount = rejectedLines.length;
  if (!anyPendingVerification && !anyPendingChecker) doc.approvedAt = doc.approvedAt ?? new Date();

  // Payment status rollup — only ever considers APPROVED lines (§31: a
  // rejected line's paymentStatus stays PENDING_APPROVAL forever, since
  // it's never attempted; unscoped `every(...)` would permanently read
  // PAYMENT_FAILED for any batch with a rejected line).
  if (approvedLines.length === 0) {
    doc.paymentStatus = "PENDING_APPROVAL";
  } else if (approvedLines.every((l) => l.paymentStatus === "PAYMENT_SUCCESS")) {
    doc.paymentStatus = "PAYMENT_SUCCESS";
  } else if (approvedLines.some((l) => l.paymentStatus === "PAYMENT_FAILED")) {
    doc.paymentStatus = "PAYMENT_FAILED";
  } else {
    doc.paymentStatus = "PAYMENT_PROCESSING";
  }
}

/**
 * Pays ONE employee line — its own paymentReference/bankSnapshot/status
 * (§30), re-fetching the beneficiary's CURRENT default bank account at this
 * moment (not whatever it was at submission — §21). Callable the instant
 * that line reaches final approval, independent of every other line's
 * progress.
 */
async function initiateLinePayment(doc: PayrollBatchDocument, line: PayrollLine, session: mongoose.ClientSession): Promise<void> {
  if (line.paymentStatus === "PAYMENT_SUCCESS") return; // already paid (retry path)

  const beneficiary = await BeneficiaryModel.findById(line.beneficiaryId).session(session);
  const defaultBank = beneficiary?.bankAccounts.find((b) => b.isDefault) ?? null;
  if (!beneficiary || !defaultBank) {
    line.paymentStatus = "PAYMENT_FAILED";
    line.paymentFailureReason = "Beneficiary has no Default Bank Account at payment time.";
    return;
  }

  line.bankSnapshot = {
    bankName: defaultBank.bankName,
    accountHolderName: defaultBank.accountHolderName,
    maskedAccountNumber: maskAccountNumber(defaultBank.accountNumber),
    ifscCode: defaultBank.ifscCode,
    beneficiaryId: beneficiary._id,
  };
  line.paymentReference = line.paymentReference ?? generatePaymentReference();
  line.paymentStatus = "PAYMENT_PROCESSING";
  line.paymentInitiatedAt = new Date();

  const result = await paymentTransferProvider.transfer({
    expenditureId: String(doc._id),
    amount: line.netSalary,
    paymentReference: line.paymentReference,
    bankSnapshot: {
      bankName: line.bankSnapshot.bankName,
      accountHolderName: line.bankSnapshot.accountHolderName,
      maskedAccountNumber: line.bankSnapshot.maskedAccountNumber,
      ifscCode: line.bankSnapshot.ifscCode,
    },
  });

  if (result.status === "SUCCESS") {
    line.paymentStatus = "PAYMENT_SUCCESS";
    line.paymentCompletedAt = new Date();
    line.paymentFailureReason = null;
  } else {
    line.paymentStatus = "PAYMENT_FAILED";
    line.paymentFailureReason = result.failureReason ?? "Payment transfer failed.";
  }
}

/** Pays every one of the given lines (defaults to every APPROVED line in the batch), then refreshes the batch's payment rollup. */
async function initiateBatchPayment(doc: PayrollBatchDocument, session: mongoose.ClientSession, lines?: PayrollLine[]): Promise<void> {
  const targets = lines ?? doc.employees.filter((l) => l.approvalStatus === "APPROVED");
  for (const line of targets) {
    // eslint-disable-next-line no-await-in-loop
    await initiateLinePayment(doc, line, session);
  }
  recomputeBatchRollup(doc);
}

// ---------------------------------------------------------------------------
// Per-line verify/approve/reject mutations — shared by the single-employee
// endpoints and by the whole-batch endpoints, which loop every line
// currently eligible for the actor's stage through the same mechanics.
// ---------------------------------------------------------------------------

function applyLineVerification(
  doc: PayrollBatchDocument,
  line: PayrollLine,
  actorId: Types.ObjectId
): { previousStatus: ApprovalStatus; nextStatus: ApprovalStatus; isFinal: boolean } {
  const { nextStatus, isFinal } = computeVerifyTransition(doc.workflowSnapshot);
  const previousStatus = line.approvalStatus;
  line.verifierId = actorId;
  line.verifiedAt = new Date();
  line.approvalStatus = nextStatus;
  if (isFinal) {
    line.approvedAt = new Date();
    line.approvedAmount = line.holdingAmount;
    line.holdingAmount = 0;
  }
  return { previousStatus, nextStatus, isFinal };
}

function applyLineApproval(line: PayrollLine, actorId: Types.ObjectId): ApprovalStatus {
  const previousStatus = line.approvalStatus;
  line.checkerId = actorId;
  line.approvalStatus = "APPROVED";
  line.approvedAt = new Date();
  line.approvedAmount = line.holdingAmount;
  line.holdingAmount = 0;
  return previousStatus;
}

/** Releases only THIS line's own reservations back to their parent pool(s) — an approved/pending sibling line's reservation is untouched. */
async function applyLineRejection(
  line: PayrollLine,
  actorId: Types.ObjectId,
  reason: string,
  isVerifierStage: boolean,
  session: mongoose.ClientSession
): Promise<ApprovalStatus> {
  await releaseToParentPool(line.sourcePools, session);
  const previousStatus = line.approvalStatus;
  line.approvalStatus = isVerifierStage ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
  line.rejectionReason = reason;
  line.rejectedBy = actorId;
  line.rejectedAt = new Date();
  line.holdingAmount = 0;
  if (isVerifierStage) line.verifierId = actorId;
  else line.checkerId = actorId;
  return previousStatus;
}

export async function retryPayrollPayment(id: string, employeeLineId: string | undefined, context: ActorContext): Promise<PayrollBatchDto> {
  const actorId = requireActorId(context);
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");

  const approvedLines = doc.employees.filter((e) => e.approvalStatus === "APPROVED");
  const linesToRetry = employeeLineId ? approvedLines.filter((e) => String(e._id) === employeeLineId) : approvedLines;
  if (linesToRetry.length === 0) throw new AppError(404, "Employee payroll line not found or not yet approved.");
  if (!linesToRetry.some((e) => e.paymentStatus === "PAYMENT_FAILED")) {
    throw new AppError(422, "No failed payment to retry for the given selection.");
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await initiateBatchPayment(doc, session, linesToRetry);
      doc.updatedBy = actorId;
      await doc.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: doc.paymentStatus === "PAYMENT_SUCCESS" ? "PAYROLL_PAYMENT_SUCCESS" : "PAYROLL_PAYMENT_FAILED",
    module: "FINANCE",
    description: `Retried payment for Payroll batch ${doc.payrollNumber} — ${doc.paymentStatus}.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

// ---------------------------------------------------------------------------
// Create / Verify / Approve / Reject
// ---------------------------------------------------------------------------

export async function createPayrollBatch(input: CreatePayrollBatchInput, context: ActorContext): Promise<PayrollBatchDto> {
  const scope = await validateScope(input);
  await assertNoDuplicatePayrollPeriod(scope, input.month);

  const allDeductionIds = [...new Set(input.employees.flatMap((e) => e.deductions.map((d) => d.deductionId)))];
  const deductionDocs =
    allDeductionIds.length > 0
      ? await DeductionMasterModel.find({ _id: { $in: allDeductionIds }, deductionType: "EMPLOYEE", isActive: true })
      : [];
  const deductionDocsById = new Map(deductionDocs.map((d) => [String(d._id), d]));
  if (deductionDocsById.size !== allDeductionIds.length) {
    throw new AppError(422, "One or more selected deductions are invalid, inactive, or not an Employee deduction.", {
      deductions: ["Only Active Employee deductions may be selected."],
    });
  }

  const beneficiaries = await Promise.all(input.employees.map((e) => validateEmployeeBeneficiary(e.beneficiaryId)));
  const beneficiaryById = new Map(beneficiaries.map((b) => [String(b._id), b]));

  const lines: PayrollLine[] = [];
  let totalGrossSalary = 0;
  let totalDeduction = 0;
  let totalNetSalary = 0;
  for (const employeeInput of input.employees) {
    const beneficiary = beneficiaryById.get(employeeInput.beneficiaryId)!;
    const resolved = await resolvePayrollLineDeductions(employeeInput.salaryAmount, employeeInput.deductions, deductionDocsById);
    lines.push({
      beneficiaryId: beneficiary._id,
      beneficiarySnapshot: { name: beneficiary.name, employeeId: beneficiary.employeeId, panNumber: beneficiary.panNumber },
      salaryAmount: round2(employeeInput.salaryAmount),
      deductions: resolved.deductions,
      totalDeduction: resolved.totalDeduction,
      netSalary: resolved.netSalary,
      paymentStatus: "PENDING_APPROVAL",
    } as PayrollLine);
    totalGrossSalary = round2(totalGrossSalary + employeeInput.salaryAmount);
    totalDeduction = round2(totalDeduction + resolved.totalDeduction);
    totalNetSalary = round2(totalNetSalary + resolved.netSalary);
  }

  const actorId = requireActorId(context);
  await assertMakerPermission({ actorId, actorRole: requireActorRole(context) }, String(scope.organizationNodeId));
  const workflow = await resolveWorkflowForNode(scope.organizationNodeId);
  const autoApproved = workflow.initialStatus === "APPROVED";

  const session = await mongoose.startSession();
  let created: PayrollBatchDocument;
  try {
    created = await session.withTransaction(async () => {
      // Reserve per employee line (not once for the combined total) — same
      // pools, same sequential order, inside the same transaction, so the
      // total reserved is identical to today, just split into N records so
      // a later per-line reject can release only that employee's share.
      for (const line of lines) {
        const reservations: ReceivedPoolReservation[] = await reserveFromNodeOwnReceivedPool(
          String(scope.organizationNodeId),
          line.salaryAmount,
          scope,
          session
        );
        line.sourcePools = reservations.map((r) => ({ kind: r.kind, poolId: r.poolId, amount: r.amount }));
        line.approvalStatus = workflow.initialStatus;
        line.verifierId = null;
        line.checkerId = null;
        line.verifiedAt = null;
        line.approvedAt = autoApproved ? new Date() : null;
        line.holdingAmount = autoApproved ? 0 : line.salaryAmount;
        line.approvedAmount = autoApproved ? line.salaryAmount : 0;
        line.rejectionReason = null;
        line.rejectedBy = null;
        line.rejectedAt = null;
      }

      const [doc] = await PayrollBatchModel.create(
        [
          {
            payrollNumber: `PR-${Date.now().toString(36).toUpperCase()}`,
            ...scope,
            beneficiaryType: "EMPLOYEE",
            month: input.month,
            sanctionNumber: input.sanctionNumber?.trim() || null,
            sanctionDate: input.sanctionDate ?? null,
            remarks: input.remarks?.trim() || null,
            enrichment1: input.enrichment1?.trim() || null,
            enrichment2: input.enrichment2?.trim() || null,
            employees: lines,
            totalGrossSalary,
            totalDeduction,
            totalNetSalary,
            approvalStatus: workflow.initialStatus,
            workflowSnapshot: workflow.snapshot,
            makerId: actorId,
            holdingAmount: autoApproved ? 0 : totalGrossSalary,
            approvedAmount: autoApproved ? totalGrossSalary : 0,
            approvedAt: autoApproved ? new Date() : null,
            hasRejectedLines: false,
            rejectedLineCount: 0,
            paymentStatus: "PENDING_APPROVAL",
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session }
      );

      await recordWorkflowEvent(
        { module: "PAYROLL", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.totalGrossSalary },
        { action: "MAKER_SUBMITTED", userId: actorId, userRole: "Maker", previousStatus: null, newStatus: workflow.initialStatus, holdingAmount: doc.holdingAmount, ipAddress: context.ipAddress },
        session
      );

      if (autoApproved) {
        await initiateBatchPayment(doc, session);
        await doc.save({ session });
      }

      return doc;
    });
  } finally {
    await session.endSession();
  }

  const totalPoolCount = lines.reduce((sum, l) => sum + l.sourcePools.length, 0);
  await logActivity({
    user: actorId,
    action: "PAYROLL_CREATED",
    module: "FINANCE",
    description: `Maker created Payroll batch ${created.payrollNumber} for ${input.month} with ${lines.length} employee(s), total ${totalGrossSalary} — drawn from ${totalPoolCount} pool(s) across ${lines.length} employee line(s), ${created.approvalStatus}.`,
    entityType: "PayrollBatch",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
  if (autoApproved) {
    await logActivity({
      user: actorId,
      action: created.paymentStatus === "PAYMENT_SUCCESS" ? "PAYROLL_PAYMENT_SUCCESS" : "PAYROLL_PAYMENT_FAILED",
      module: "FINANCE",
      description: `Payroll batch ${created.payrollNumber} auto-approved (Maker-only workflow) — payment ${created.paymentStatus}.`,
      entityType: "PayrollBatch",
      entityId: created._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  const maps = await buildLookupMaps();
  return serialize(created, maps);
}

/**
 * Loops every line currently at the Verifier stage through the same
 * mechanics as verifyPayrollLine — identical observable behavior to the
 * old whole-batch-only implementation when every line shares a stage (the
 * common case), and well-defined for a batch some of whose lines have
 * already progressed further (those are simply left untouched).
 */
export async function verifyPayrollBatch(id: string, input: { remarks?: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION") throw new AppError(422, "This Payroll batch is not pending verification.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: null, checkerId: null, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const eligibleLines = doc.employees.filter((l) => l.approvalStatus === "PENDING_VERIFICATION");
  let finalCount = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const line of eligibleLines) {
        const applied = applyLineVerification(doc, line, actorId);
        if (applied.isFinal) {
          finalCount += 1;
          // eslint-disable-next-line no-await-in-loop
          await initiateLinePayment(doc, line, session);
        }
        // eslint-disable-next-line no-await-in-loop
        await recordWorkflowEvent(
          { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
          { action: "VERIFIER_VERIFIED", userId: actorId, userRole: "Verifier", previousStatus: applied.previousStatus, newStatus: line.approvalStatus, holdingAmount: line.holdingAmount, remarks: input.remarks, ipAddress: context.ipAddress },
          session
        );
      }
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "PAYROLL_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified ${eligibleLines.length} employee line(s) in Payroll batch ${doc.payrollNumber}${finalCount > 0 ? ` — ${finalCount} reached final approval, payment ${doc.paymentStatus}.` : "."}`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

/** Loops every line currently at the Checker stage through the same mechanics as approvePayrollLine. */
export async function approvePayrollBatch(id: string, input: { remarks?: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") throw new AppError(422, "This Payroll batch is not pending Checker approval.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: null, checkerId: null, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const eligibleLines = doc.employees.filter((l) => l.approvalStatus === "PENDING_CHECKER_APPROVAL");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const line of eligibleLines) {
        const previousStatus = applyLineApproval(line, actorId);
        // eslint-disable-next-line no-await-in-loop
        await initiateLinePayment(doc, line, session);
        // eslint-disable-next-line no-await-in-loop
        await recordWorkflowEvent(
          { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
          { action: "CHECKER_APPROVED", userId: actorId, userRole: "Checker", previousStatus, newStatus: "APPROVED", holdingAmount: 0, remarks: input.remarks, ipAddress: context.ipAddress },
          session
        );
      }
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "PAYROLL_FINAL_APPROVED",
    module: "FINANCE",
    description: `Checker approved ${eligibleLines.length} employee line(s) in Payroll batch ${doc.payrollNumber} — final approval, payment ${doc.paymentStatus}.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

/** Loops every line currently eligible for the actor's stage through the same mechanics as rejectPayrollLine. */
export async function rejectPayrollBatch(id: string, input: { reason: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION" && doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Payroll batch is not pending any approval.");
  }
  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: null, checkerId: null, workflowSnapshot: doc.workflowSnapshot }, actorId);

  const isVerifierStage = doc.approvalStatus === "PENDING_VERIFICATION";
  if (isVerifierStage) {
    await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  } else {
    await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  }

  const stageStatus: ApprovalStatus = isVerifierStage ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  const eligibleLines = doc.employees.filter((l) => l.approvalStatus === stageStatus);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const line of eligibleLines) {
        // eslint-disable-next-line no-await-in-loop
        const previousStatus = await applyLineRejection(line, actorId, input.reason, isVerifierStage, session);
        // eslint-disable-next-line no-await-in-loop
        await recordWorkflowEvent(
          { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
          {
            action: isVerifierStage ? "VERIFIER_REJECTED" : "CHECKER_REJECTED",
            userId: actorId,
            userRole: isVerifierStage ? "Verifier" : "Checker",
            previousStatus,
            newStatus: line.approvalStatus,
            holdingAmount: 0,
            remarks: input.reason,
            ipAddress: context.ipAddress,
          },
          session
        );
      }
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: isVerifierStage ? "PAYROLL_REJECTED_BY_VERIFIER" : "PAYROLL_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected ${eligibleLines.length} employee line(s) in Payroll batch ${doc.payrollNumber}: ${input.reason} — Holding released.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

// ---------------------------------------------------------------------------
// Per-employee verify/approve/reject — act on one employee line within a
// batch independently of every other line's progress.
// ---------------------------------------------------------------------------

function findPayrollLine(doc: PayrollBatchDocument, lineId: string): PayrollLine {
  const line = doc.employees.find((e) => String(e._id) === lineId);
  if (!line) throw new AppError(404, "Employee payroll line not found.");
  return line;
}

export async function verifyPayrollLine(batchId: string, lineId: string, input: { remarks?: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(batchId);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  const line = findPayrollLine(doc, lineId);
  if (line.approvalStatus !== "PENDING_VERIFICATION") throw new AppError(422, "This employee's payroll is not pending verification.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: line.verifierId, checkerId: line.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  let isFinal = false;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const applied = applyLineVerification(doc, line, actorId);
      isFinal = applied.isFinal;
      if (isFinal) await initiateLinePayment(doc, line, session);
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
        { action: "VERIFIER_VERIFIED", userId: actorId, userRole: "Verifier", previousStatus: applied.previousStatus, newStatus: line.approvalStatus, holdingAmount: line.holdingAmount, remarks: input.remarks, ipAddress: context.ipAddress },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "PAYROLL_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified ${line.beneficiarySnapshot.name}'s payroll line in batch ${doc.payrollNumber}${isFinal ? ` — final approval, payment ${line.paymentStatus}.` : "."}`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function approvePayrollLine(batchId: string, lineId: string, input: { remarks?: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(batchId);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  const line = findPayrollLine(doc, lineId);
  if (line.approvalStatus !== "PENDING_CHECKER_APPROVAL") throw new AppError(422, "This employee's payroll is not pending Checker approval.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: line.verifierId, checkerId: line.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const previousStatus = applyLineApproval(line, actorId);
      await initiateLinePayment(doc, line, session);
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
        { action: "CHECKER_APPROVED", userId: actorId, userRole: "Checker", previousStatus, newStatus: "APPROVED", holdingAmount: 0, remarks: input.remarks, ipAddress: context.ipAddress },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "PAYROLL_FINAL_APPROVED",
    module: "FINANCE",
    description: `Checker approved ${line.beneficiarySnapshot.name}'s payroll line in batch ${doc.payrollNumber} — final approval, payment ${line.paymentStatus}.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function rejectPayrollLine(batchId: string, lineId: string, input: { reason: string }, context: ActorContext): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(batchId);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  const line = findPayrollLine(doc, lineId);
  if (line.approvalStatus !== "PENDING_VERIFICATION" && line.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This employee's payroll is not pending any approval.");
  }

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: line.verifierId, checkerId: line.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);

  const isVerifierStage = line.approvalStatus === "PENDING_VERIFICATION";
  if (isVerifierStage) {
    await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  } else {
    await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const previousStatus = await applyLineRejection(line, actorId, input.reason, isVerifierStage, session);
      recomputeBatchRollup(doc);
      doc.updatedBy = actorId;
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "PAYROLL", recordId: doc._id, employeeLineId: line._id, organizationNodeId: doc.organizationNodeId, amount: line.salaryAmount },
        {
          action: isVerifierStage ? "VERIFIER_REJECTED" : "CHECKER_REJECTED",
          userId: actorId,
          userRole: isVerifierStage ? "Verifier" : "Checker",
          previousStatus,
          newStatus: line.approvalStatus,
          holdingAmount: 0,
          remarks: input.reason,
          ipAddress: context.ipAddress,
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: isVerifierStage ? "PAYROLL_REJECTED_BY_VERIFIER" : "PAYROLL_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected ${line.beneficiarySnapshot.name}'s payroll line in batch ${doc.payrollNumber}: ${input.reason} — Holding released.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

// ---------------------------------------------------------------------------
// Bulk verify/approve (§26)
// ---------------------------------------------------------------------------

export interface BulkWorkflowResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
}

async function processBulkWorkflowAction(ids: string[], action: (id: string) => Promise<unknown>): Promise<BulkWorkflowResult> {
  const result: BulkWorkflowResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await action(id);
      result.succeeded.push(id);
    } catch (error) {
      result.failed.push({ id, reason: error instanceof AppError ? error.message : "Failed to process this Payroll batch." });
    }
  }
  return result;
}

export async function bulkVerifyPayrollBatches(ids: string[], input: { remarks?: string }, context: ActorContext): Promise<BulkWorkflowResult> {
  return processBulkWorkflowAction(ids, (id) => verifyPayrollBatch(id, input, context));
}
export async function bulkApprovePayrollBatches(ids: string[], input: { remarks?: string }, context: ActorContext): Promise<BulkWorkflowResult> {
  return processBulkWorkflowAction(ids, (id) => approvePayrollBatch(id, input, context));
}
export async function bulkRejectPayrollBatches(ids: string[], input: { reason: string }, context: ActorContext): Promise<BulkWorkflowResult> {
  return processBulkWorkflowAction(ids, (id) => rejectPayrollBatch(id, input, context));
}

// ---------------------------------------------------------------------------
// Listing / export / pending-approvals / attachments
// ---------------------------------------------------------------------------

function buildListMatch(query: PayrollListQuery | PayrollExportQuery, allowedNodeIds?: string[] | null): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (query.month) match.month = query.month;
  if (query.organizationNodeId) match.organizationNodeId = new Types.ObjectId(query.organizationNodeId);
  if (query.schemeHeadRootNodeId) match.schemeHeadRootNodeId = new Types.ObjectId(query.schemeHeadRootNodeId);
  if (query.financialYearId) match.financialYearId = new Types.ObjectId(query.financialYearId);
  if (query.approvalStatus) match.approvalStatus = query.approvalStatus;
  if (query.paymentStatus) match.paymentStatus = query.paymentStatus;
  if (query.maker) match.makerId = new Types.ObjectId(query.maker);
  if (query.verifier) match.verifierId = new Types.ObjectId(query.verifier);
  if (query.dateFrom || query.dateTo) {
    const createdAt: Record<string, Date> = {};
    if (query.dateFrom) createdAt.$gte = query.dateFrom;
    if (query.dateTo) createdAt.$lte = query.dateTo;
    match.createdAt = createdAt;
  }
  if (query.amountFrom !== undefined || query.amountTo !== undefined) {
    const totalNetSalary: Record<string, number> = {};
    if (query.amountFrom !== undefined) totalNetSalary.$gte = query.amountFrom;
    if (query.amountTo !== undefined) totalNetSalary.$lte = query.amountTo;
    match.totalNetSalary = totalNetSalary;
  }

  const andConditions: Record<string, unknown>[] = [];
  if (allowedNodeIds) andConditions.push({ organizationNodeId: { $in: allowedNodeIds.map((id) => new Types.ObjectId(id)) } });
  if (query.search) {
    const regex = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    andConditions.push({ $or: [{ payrollNumber: regex }, { sanctionNumber: regex }, { "employees.beneficiarySnapshot.name": regex }] });
  }
  if (andConditions.length > 0) match.$and = andConditions;
  return match;
}

export async function listPayrollBatches(query: PayrollListQuery, allowedNodeIds: string[] | null): Promise<ListResult<PayrollBatchDto>> {
  const match = buildListMatch(query, allowedNodeIds);
  const [docs, total] = await Promise.all([
    PayrollBatchModel.find(match)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    PayrollBatchModel.countDocuments(match),
  ]);
  const maps = await buildLookupMaps();
  return {
    items: docs.map((doc) => serialize(doc, maps)),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getPayrollBatchCursorForExport(query: PayrollExportQuery, allowedNodeIds: string[] | null) {
  const match = buildListMatch(query, allowedNodeIds);
  return PayrollBatchModel.find(match)
    .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
    .cursor();
}

export async function getPayrollBatchById(id: string, allowedNodeIds: string[] | null): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");
  if (allowedNodeIds && !allowedNodeIds.includes(String(doc.organizationNodeId))) {
    throw new AppError(404, "Payroll batch not found.");
  }
  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function listPendingPayrollApprovalsForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: PayrollListQuery
): Promise<ListResult<PayrollBatchDto>> {
  const actionableNodeIds = await getMyActionableNodeIds(actor, stage);
  const allowedNodeIds = actionableNodeIds === "ALL" ? null : actionableNodeIds;

  if (query.organizationNodeId && allowedNodeIds && !allowedNodeIds.includes(query.organizationNodeId)) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }
  if (allowedNodeIds && allowedNodeIds.length === 0) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }

  // Matched against each employee LINE's own approvalStatus, not the
  // batch-level rollup — a batch with some lines still at Verifier stage
  // and others already at Checker stage rolls up to PENDING_VERIFICATION
  // (the earliest stage wins), which would otherwise hide it from the
  // Checker's queue until every other line also clears Verifier.
  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  const match = buildListMatch({ ...query, approvalStatus: undefined }, allowedNodeIds);
  match.employees = { $elemMatch: { approvalStatus: forcedStatus } };

  const [docs, total] = await Promise.all([
    PayrollBatchModel.find(match)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    PayrollBatchModel.countDocuments(match),
  ]);
  const maps = await buildLookupMaps();
  return {
    items: docs.map((doc) => serialize(doc, maps)),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getAllowedNodeIdsForPayroll(actor: ActorForPermission) {
  return getAllowedNodeIdsForList(actor);
}

export async function addPayrollBatchDocument(
  id: string,
  documentInfo: string | undefined,
  file: Express.Multer.File,
  context: ActorContext
): Promise<PayrollBatchDto> {
  const doc = await PayrollBatchModel.findById(id);
  if (!doc) throw new AppError(404, "Payroll batch not found.");

  const { url, storedFileName } = await uploadToBlob("payroll-batches", "doc", file.originalname, file.buffer, file.mimetype);
  doc.attachments.push({
    documentInfo: documentInfo?.trim() || null,
    fileName: storedFileName,
    originalName: file.originalname,
    fileUrl: url,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: context.actorId,
    uploadedAt: new Date(),
  } as never);
  doc.updatedBy = context.actorId;
  await doc.save();

  await logActivity({
    user: context.actorId,
    action: "PAYROLL_DOCUMENT_UPLOADED",
    module: "FINANCE",
    description: `Uploaded document "${file.originalname}" to Payroll batch ${doc.payrollNumber}.`,
    entityType: "PayrollBatch",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}
