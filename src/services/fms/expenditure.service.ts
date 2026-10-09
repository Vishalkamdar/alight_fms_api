import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { ExpenditureModel, type ExpenditureDocument, type ExpenditureDeductionSnapshot, type ExpenditureSourcePool } from "../../models/fms/Expenditure";
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
import type {
  CreateExpenditureInput,
  ExpenditureExportQuery,
  ExpenditureListQuery,
} from "../../schemas/fms/expenditure.schema";

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

export interface ExpenditureDto {
  _id: string;
  financialYearId: string;
  financialYear: FinancialYearRef | null;
  organizationRootNodeId: string;
  organizationNodeId: string;
  organizationNode: NodeRef | null;
  schemeHeadRootNodeId: string;
  schemeHeadRoot: NodeRef | null;
  headId: string;
  head: NodeRef | null;
  beneficiaryType: "VENDOR" | "EMPLOYEE";
  beneficiaryId: string;
  beneficiarySnapshot: { name: string; beneficiaryType: "VENDOR" | "EMPLOYEE"; panNumber: string | null; gstNumber: string | null };
  paymentType: "ONLINE" | "CASH";
  billVoucherNumber: string;
  billVoucherDate: Date;
  debitNarration: string | null;
  creditNarration: string | null;
  remarks: string | null;
  enrichment1: string | null;
  enrichment2: string | null;
  particulars: { description: string; amount: number }[];
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
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: string;
  maker: UserRef | null;
  verifierId: string | null;
  checkerId: string | null;
  holdingAmount: number;
  approvedAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  paymentStatus: "PENDING_APPROVAL" | "APPROVED" | "PAYMENT_PENDING" | "PAYMENT_PROCESSING" | "PAYMENT_SUCCESS" | "PAYMENT_FAILED";
  paymentReference: string | null;
  bankSnapshot: { bankName: string; accountHolderName: string; maskedAccountNumber: string; ifscCode: string } | null;
  paymentFailureReason: string | null;
  paymentInitiatedAt: Date | null;
  paymentCompletedAt: Date | null;
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
  const [orgNodes, schemeHeadNodes, financialYears, makers] = await Promise.all([
    OrganizationNodeModel.find().select("name").lean(),
    SchemeHeadNodeModel.find().select("name").lean(),
    FinancialYearModel.find().select("financialYear").lean(),
    UserModel.find().select("fullname").lean(),
  ]);
  return {
    orgNodeMap: new Map<string, NodeRef>(orgNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])),
    schemeHeadNodeMap: new Map<string, NodeRef>(schemeHeadNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])),
    financialYearMap: new Map<string, FinancialYearRef>(financialYears.map((y) => [String(y._id), { _id: String(y._id), financialYear: y.financialYear }])),
    makerMap: new Map<string, UserRef>(makers.map((u) => [String(u._id), { _id: String(u._id), fullname: u.fullname }])),
  };
}

function serialize(doc: ExpenditureDocument, maps: Awaited<ReturnType<typeof buildLookupMaps>>): ExpenditureDto {
  const financialYearId = String(doc.financialYearId);
  const organizationNodeId = String(doc.organizationNodeId);
  const schemeHeadRootNodeId = String(doc.schemeHeadRootNodeId);
  const headId = String(doc.headId);
  const makerId = String(doc.makerId);

  return {
    _id: String(doc._id),
    financialYearId,
    financialYear: maps.financialYearMap.get(financialYearId) ?? null,
    organizationRootNodeId: String(doc.organizationRootNodeId),
    organizationNodeId,
    organizationNode: maps.orgNodeMap.get(organizationNodeId) ?? null,
    schemeHeadRootNodeId,
    schemeHeadRoot: maps.schemeHeadNodeMap.get(schemeHeadRootNodeId) ?? null,
    headId,
    head: maps.schemeHeadNodeMap.get(headId) ?? null,
    beneficiaryType: doc.beneficiaryType,
    beneficiaryId: String(doc.beneficiaryId),
    beneficiarySnapshot: doc.beneficiarySnapshot,
    paymentType: doc.paymentType,
    billVoucherNumber: doc.billVoucherNumber,
    billVoucherDate: doc.billVoucherDate,
    debitNarration: doc.debitNarration,
    creditNarration: doc.creditNarration,
    remarks: doc.remarks,
    enrichment1: doc.enrichment1,
    enrichment2: doc.enrichment2,
    particulars: doc.particulars,
    grossAmount: doc.grossAmount,
    cgstPercent: doc.cgstPercent,
    cgstAmount: doc.cgstAmount,
    sgstPercent: doc.sgstPercent,
    sgstAmount: doc.sgstAmount,
    igstPercent: doc.igstPercent,
    igstAmount: doc.igstAmount,
    totalWithTax: doc.totalWithTax,
    deductions: doc.deductions,
    totalDeduction: doc.totalDeduction,
    netPayableAmount: doc.netPayableAmount,
    approvalStatus: doc.approvalStatus,
    workflowSnapshot: doc.workflowSnapshot,
    makerId,
    maker: maps.makerMap.get(makerId) ?? null,
    verifierId: doc.verifierId ? String(doc.verifierId) : null,
    checkerId: doc.checkerId ? String(doc.checkerId) : null,
    holdingAmount: doc.holdingAmount,
    approvedAmount: doc.approvedAmount,
    verifiedAt: doc.verifiedAt,
    approvedAt: doc.approvedAt,
    rejectionReason: doc.rejectionReason,
    rejectedBy: doc.rejectedBy ? String(doc.rejectedBy) : null,
    rejectedAt: doc.rejectedAt,
    paymentStatus: doc.paymentStatus,
    paymentReference: doc.paymentReference,
    bankSnapshot: doc.bankSnapshot
      ? {
          bankName: doc.bankSnapshot.bankName,
          accountHolderName: doc.bankSnapshot.accountHolderName,
          maskedAccountNumber: doc.bankSnapshot.maskedAccountNumber,
          ifscCode: doc.bankSnapshot.ifscCode,
        }
      : null,
    paymentFailureReason: doc.paymentFailureReason,
    paymentInitiatedAt: doc.paymentInitiatedAt,
    paymentCompletedAt: doc.paymentCompletedAt,
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
// Amount calculation — the single source of truth, called on create and
// never trusted from the client (§11/§13). Deduction amounts are the one
// exception, by explicit product requirement: the reference "Specify
// Deductions" table lets the Maker type either a Percentage or a Rs. amount
// per row (whichever is more convenient for that bill), so the amount they
// land on IS the real deducted figure — the server still independently
// re-verifies the deductionId is an Active Vendor deduction (never an
// Employee one, never inactive, never invented) and that the total can
// never exceed the expenditure amount, but does not second-guess the Rs.
// figure itself the way Gross/Tax are always recomputed from scratch.
// ---------------------------------------------------------------------------

interface ComputedAmounts {
  grossAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalWithTax: number;
}

function computeExpenditureAmounts(
  particulars: Array<{ description: string; amount: number }>,
  tax: { cgstPercent: number; sgstPercent: number; igstPercent: number }
): ComputedAmounts {
  const grossAmount = round2(particulars.reduce((sum, p) => sum + p.amount, 0));
  const cgstAmount = round2((grossAmount * tax.cgstPercent) / 100);
  const sgstAmount = round2((grossAmount * tax.sgstPercent) / 100);
  const igstAmount = round2((grossAmount * tax.igstPercent) / 100);
  const totalWithTax = round2(grossAmount + cgstAmount + sgstAmount + igstAmount);
  return { grossAmount, cgstAmount, sgstAmount, igstAmount, totalWithTax };
}

interface DeductionSelection {
  deductionId: string;
  percentage?: number;
  amount: number;
}

/**
 * Resolves each selected deduction against the live Deduction Master —
 * existence, Active, and VENDOR-type are always re-checked (a crafted
 * request can never slip an Employee or inactive deduction through, even
 * though the amount itself is trusted — §9/§13) — and builds the frozen
 * snapshot stored on the record (§24). Always empty for Employee (§9).
 */
async function resolveVendorDeductionSnapshots(
  selections: DeductionSelection[],
  beneficiaryType: "VENDOR" | "EMPLOYEE"
): Promise<ExpenditureDeductionSnapshot[]> {
  if (beneficiaryType === "EMPLOYEE" || selections.length === 0) return [];

  const docs = await DeductionMasterModel.find({ _id: { $in: selections.map((s) => s.deductionId) }, deductionType: "VENDOR", isActive: true });
  if (docs.length !== selections.length) {
    throw new AppError(422, "One or more selected deductions are invalid, inactive, or not a Vendor deduction.", {
      deductions: ["Only Active Vendor deductions may be selected."],
    });
  }
  const docById = new Map(docs.map((d) => [String(d._id), d]));

  return selections.map((selection) => {
    const doc = docById.get(selection.deductionId)!;
    const calculatedAmount = round2(selection.amount);
    return {
      deductionId: doc._id,
      deductionName: doc.name,
      deductionType: "VENDOR",
      calculationType: doc.calculationType,
      percentage: selection.percentage ?? null,
      fixedAmount: calculatedAmount,
      calculatedAmount,
    };
  });
}

function sumDeductions(deductionSnapshots: ExpenditureDeductionSnapshot[], totalWithTax: number): number {
  const totalDeduction = round2(deductionSnapshots.reduce((sum, d) => sum + d.calculatedAmount, 0));
  if (totalDeduction > totalWithTax) {
    throw new AppError(422, "Total Deductions exceed the Gross Amount + Tax — Net Payable cannot be negative.", {
      deductions: ["Deductions exceed the expenditure amount."],
    });
  }
  return totalDeduction;
}

// ---------------------------------------------------------------------------
// Scope / beneficiary validation
// ---------------------------------------------------------------------------

interface ValidatedScope {
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  headId: Types.ObjectId;
}

/** Same hierarchyPath-prefix check budget-allocation.service.ts uses internally (not exported there, so reimplemented here). */
async function isSchemeHeadSelfOrDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
  if (candidateId === ancestorId) return true;
  const [candidate, ancestor] = await Promise.all([
    SchemeHeadNodeModel.findById(candidateId).select("hierarchyPath"),
    SchemeHeadNodeModel.findById(ancestorId).select("hierarchyPath"),
  ]);
  if (!candidate || !ancestor) return false;
  const ancestorFullPath = `${ancestor.hierarchyPath}${ancestorId}/`;
  return candidate.hierarchyPath.startsWith(ancestorFullPath);
}

async function validateScope(input: {
  financialYearId: string;
  organizationRootNodeId: string;
  organizationNodeId: string;
  schemeHeadRootNodeId: string;
  headId: string;
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

  const headNode = await SchemeHeadNodeModel.findById(input.headId);
  if (!headNode) throw new AppError(422, "The selected Head does not exist.", { headId: ["Not found."] });
  if (headNode.status !== "Active") throw new AppError(422, "The selected Head is inactive.", { headId: ["Must be active."] });
  const headInScope = await isSchemeHeadSelfOrDescendant(input.headId, input.schemeHeadRootNodeId);
  if (!headInScope) {
    throw new AppError(422, "The selected Head does not belong to this scope's Scheme/Head hierarchy.", {
      headId: ["Head must be under the selected root Scheme/Head Node."],
    });
  }

  return {
    financialYearId: new Types.ObjectId(input.financialYearId),
    organizationRootNodeId: new Types.ObjectId(input.organizationRootNodeId),
    organizationNodeId: new Types.ObjectId(input.organizationNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(input.schemeHeadRootNodeId),
    headId: new Types.ObjectId(input.headId),
  };
}

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4 ? `••${accountNumber.slice(-4)}` : accountNumber;
}

/**
 * §6 — a Vendor expenditure can never reference an Employee beneficiary and
 * vice versa; this is re-checked here regardless of what the frontend
 * already filtered, since a crafted request must not be able to mismatch
 * them. §4 — Online payment requires the beneficiary to currently have a
 * default bank account; Cash never looks at bank details at all.
 */
async function validateBeneficiary(beneficiaryType: "VENDOR" | "EMPLOYEE", beneficiaryId: string, paymentType: "ONLINE" | "CASH") {
  const beneficiary = await BeneficiaryModel.findById(beneficiaryId);
  if (!beneficiary) throw new AppError(422, "The selected Beneficiary does not exist.", { beneficiaryId: ["Not found."] });
  if (!beneficiary.isActive) throw new AppError(422, "The selected Beneficiary is inactive.", { beneficiaryId: ["Must be active."] });
  if (beneficiary.beneficiaryType !== beneficiaryType) {
    throw new AppError(422, `The selected Beneficiary is not a ${beneficiaryType === "VENDOR" ? "Vendor" : "Employee"}.`, {
      beneficiaryId: ["Beneficiary Type mismatch."],
    });
  }

  const defaultBank = beneficiary.bankAccounts.find((b) => b.isDefault) ?? null;
  if (paymentType === "ONLINE" && !defaultBank) {
    throw new AppError(422, "This Beneficiary has no Default Bank Account on file — required for Online payment.", {
      paymentType: ["Beneficiary has no bank account; choose Cash or add a bank account in Beneficiary Master."],
    });
  }

  return { beneficiary, defaultBank };
}

// ---------------------------------------------------------------------------
// Payment (§16-19)
// ---------------------------------------------------------------------------

/** Mutates `doc` in place (approval fields) — caller saves once, alongside whatever initiatePayment also sets. */
function applyFinalApproval(doc: ExpenditureDocument): void {
  doc.approvalStatus = "APPROVED";
  doc.holdingAmount = 0;
  doc.approvedAmount = doc.totalWithTax;
  doc.approvedAt = new Date();
}

/**
 * The only place that calls the payment-transfer stub. Cash never attempts
 * a transfer (§4) and is marked successful immediately. Online re-fetches
 * the beneficiary's CURRENT default bank account (not whatever it was at
 * submission — §19) and generates `paymentReference` once; a failure here
 * never touches approvalStatus/approvedAmount (§18) and never retries
 * automatically — see retryPayment for the manual re-entry.
 */
async function initiatePayment(doc: ExpenditureDocument, session: mongoose.ClientSession): Promise<void> {
  doc.paymentStatus = "APPROVED";

  if (doc.paymentType === "CASH") {
    doc.paymentStatus = "PAYMENT_SUCCESS";
    doc.paymentCompletedAt = new Date();
    return;
  }

  const beneficiary = await BeneficiaryModel.findById(doc.beneficiaryId).session(session);
  const defaultBank = beneficiary?.bankAccounts.find((b) => b.isDefault) ?? null;
  if (!beneficiary || !defaultBank) {
    doc.paymentStatus = "PAYMENT_FAILED";
    doc.paymentFailureReason = "Beneficiary has no Default Bank Account at payment time.";
    return;
  }

  doc.bankSnapshot = {
    bankName: defaultBank.bankName,
    accountHolderName: defaultBank.accountHolderName,
    maskedAccountNumber: maskAccountNumber(defaultBank.accountNumber),
    ifscCode: defaultBank.ifscCode,
    beneficiaryId: beneficiary._id,
  };
  doc.paymentReference = doc.paymentReference ?? generatePaymentReference();
  doc.paymentStatus = "PAYMENT_PROCESSING";
  doc.paymentInitiatedAt = new Date();

  const result = await paymentTransferProvider.transfer({
    expenditureId: String(doc._id),
    amount: doc.netPayableAmount,
    paymentReference: doc.paymentReference,
    bankSnapshot: {
      bankName: doc.bankSnapshot.bankName,
      accountHolderName: doc.bankSnapshot.accountHolderName,
      maskedAccountNumber: doc.bankSnapshot.maskedAccountNumber,
      ifscCode: doc.bankSnapshot.ifscCode,
    },
  });

  if (result.status === "SUCCESS") {
    doc.paymentStatus = "PAYMENT_SUCCESS";
    doc.paymentCompletedAt = new Date();
    doc.paymentFailureReason = null;
  } else {
    doc.paymentStatus = "PAYMENT_FAILED";
    doc.paymentFailureReason = result.failureReason ?? "Payment transfer failed.";
  }
}

export async function retryExpenditurePayment(id: string, context: ActorContext): Promise<ExpenditureDto> {
  const actorId = requireActorId(context);
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");
  if (doc.approvalStatus !== "APPROVED") throw new AppError(422, "This Expenditure has not been approved yet.");
  if (doc.paymentStatus !== "PAYMENT_FAILED") throw new AppError(422, "This Expenditure's payment is not in a failed state.");

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await initiatePayment(doc, session);
      doc.updatedBy = actorId;
      await doc.save({ session });
    });
  } finally {
    await session.endSession();
  }

  const finalPaymentStatus: string = doc.paymentStatus;
  await logActivity({
    user: actorId,
    action: finalPaymentStatus === "PAYMENT_SUCCESS" ? "EXPENDITURE_PAYMENT_SUCCESS" : "EXPENDITURE_PAYMENT_FAILED",
    module: "FINANCE",
    description: `Retried payment for Expenditure ${String(doc._id)} — ${finalPaymentStatus}.`,
    entityType: "Expenditure",
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

export async function createExpenditure(input: CreateExpenditureInput, context: ActorContext): Promise<ExpenditureDto> {
  const scope = await validateScope(input);
  const { beneficiary } = await validateBeneficiary(input.beneficiaryType, input.beneficiaryId, input.paymentType);

  const computed = computeExpenditureAmounts(input.particulars, {
    cgstPercent: input.cgstPercent,
    sgstPercent: input.sgstPercent,
    igstPercent: input.igstPercent,
  });
  const deductionSnapshots = await resolveVendorDeductionSnapshots(input.deductions, input.beneficiaryType);
  const totalDeduction = sumDeductions(deductionSnapshots, computed.totalWithTax);
  const amounts = {
    ...computed,
    deductionSnapshots,
    totalDeduction,
    netPayableAmount: round2(computed.totalWithTax - totalDeduction),
  };

  const actorId = requireActorId(context);
  await assertMakerPermission({ actorId, actorRole: requireActorRole(context) }, String(scope.organizationNodeId));
  const workflow = await resolveWorkflowForNode(scope.organizationNodeId);
  const autoApproved = workflow.initialStatus === "APPROVED";

  const session = await mongoose.startSession();
  let created: ExpenditureDocument;
  let sourcePools: ExpenditureSourcePool[];
  try {
    const result = await session.withTransaction(async () => {
      const reservations: ReceivedPoolReservation[] = await reserveFromNodeOwnReceivedPool(
        String(scope.organizationNodeId),
        amounts.totalWithTax,
        scope,
        session
      );
      const pools: ExpenditureSourcePool[] = reservations.map((r) => ({ kind: r.kind, poolId: r.poolId, amount: r.amount }));

      const [doc] = await ExpenditureModel.create(
        [
          {
            ...scope,
            beneficiaryType: input.beneficiaryType,
            beneficiaryId: beneficiary._id,
            beneficiarySnapshot: {
              name: beneficiary.name,
              beneficiaryType: beneficiary.beneficiaryType,
              panNumber: beneficiary.panNumber,
              gstNumber: beneficiary.gstNumber,
            },
            paymentType: input.paymentType,
            billVoucherNumber: input.billVoucherNumber.trim(),
            billVoucherDate: input.billVoucherDate,
            debitNarration: input.debitNarration?.trim() || null,
            creditNarration: input.creditNarration?.trim() || null,
            remarks: input.remarks?.trim() || null,
            enrichment1: input.enrichment1?.trim() || null,
            enrichment2: input.enrichment2?.trim() || null,
            particulars: input.particulars,
            grossAmount: amounts.grossAmount,
            cgstPercent: input.cgstPercent,
            cgstAmount: amounts.cgstAmount,
            sgstPercent: input.sgstPercent,
            sgstAmount: amounts.sgstAmount,
            igstPercent: input.igstPercent,
            igstAmount: amounts.igstAmount,
            totalWithTax: amounts.totalWithTax,
            deductions: amounts.deductionSnapshots,
            totalDeduction: amounts.totalDeduction,
            netPayableAmount: amounts.netPayableAmount,
            approvalStatus: workflow.initialStatus,
            workflowSnapshot: workflow.snapshot,
            makerId: actorId,
            holdingAmount: autoApproved ? 0 : amounts.totalWithTax,
            approvedAmount: autoApproved ? amounts.totalWithTax : 0,
            approvedAt: autoApproved ? new Date() : null,
            sourcePools: pools,
            paymentStatus: "PENDING_APPROVAL",
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session }
      );

      await recordWorkflowEvent(
        { module: "EXPENDITURE", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.totalWithTax },
        {
          action: "MAKER_SUBMITTED",
          userId: actorId,
          userRole: "Maker",
          previousStatus: null,
          newStatus: workflow.initialStatus,
          holdingAmount: doc.holdingAmount,
          ipAddress: context.ipAddress,
        },
        session
      );

      if (autoApproved) {
        applyFinalApproval(doc);
        await initiatePayment(doc, session);
        await doc.save({ session });
      }

      return { doc, pools };
    });
    created = result.doc;
    sourcePools = result.pools;
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "EXPENDITURE_CREATED",
    module: "FINANCE",
    description: `Maker created a ${input.beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} Expenditure of ${amounts.totalWithTax} for "${beneficiary.name}" — drawn from ${sourcePools.length} pool(s), ${created.approvalStatus}.`,
    entityType: "Expenditure",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
  if (autoApproved) {
    await logActivity({
      user: actorId,
      action: created.paymentStatus === "PAYMENT_SUCCESS" ? "EXPENDITURE_PAYMENT_SUCCESS" : "EXPENDITURE_PAYMENT_FAILED",
      module: "FINANCE",
      description: `Expenditure ${String(created._id)} auto-approved (Maker-only workflow) — payment ${created.paymentStatus}.`,
      entityType: "Expenditure",
      entityId: created._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  const maps = await buildLookupMaps();
  return serialize(created, maps);
}

export async function verifyExpenditure(id: string, input: { remarks?: string }, context: ActorContext): Promise<ExpenditureDto> {
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION") throw new AppError(422, "This Expenditure is not pending verification.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  // The exact gate that prevents a Verifier-only approval from paying out
  // when a Checker is also required (§14) — `isFinal` is false whenever
  // workflowSnapshot.checkerRequired is true, so applyFinalApproval/
  // initiatePayment are simply never reached in that case; the record moves
  // to PENDING_CHECKER_APPROVAL with paymentStatus untouched.
  const { nextStatus, isFinal } = computeVerifyTransition(doc.workflowSnapshot);
  const previousStatus = doc.approvalStatus;

  doc.verifierId = actorId;
  doc.verifiedAt = new Date();
  doc.approvalStatus = nextStatus;
  doc.updatedBy = actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (isFinal) {
        applyFinalApproval(doc);
        await initiatePayment(doc, session);
      }
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "EXPENDITURE", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.totalWithTax },
        {
          action: "VERIFIER_VERIFIED",
          userId: actorId,
          userRole: "Verifier",
          previousStatus,
          newStatus: nextStatus,
          holdingAmount: doc.holdingAmount,
          remarks: input.remarks,
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
    action: "EXPENDITURE_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified Expenditure ${String(doc._id)}${isFinal ? ` — final approval, payment ${doc.paymentStatus}.` : "."}`,
    entityType: "Expenditure",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function approveExpenditure(id: string, input: { remarks?: string }, context: ActorContext): Promise<ExpenditureDto> {
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") throw new AppError(422, "This Expenditure is not pending Checker approval.");

  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);
  await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const previousStatus = doc.approvalStatus;
  doc.checkerId = actorId;
  doc.updatedBy = actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      applyFinalApproval(doc);
      await initiatePayment(doc, session);
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "EXPENDITURE", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.totalWithTax },
        {
          action: "CHECKER_APPROVED",
          userId: actorId,
          userRole: "Checker",
          previousStatus,
          newStatus: "APPROVED",
          holdingAmount: 0,
          remarks: input.remarks,
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
    action: "EXPENDITURE_FINAL_APPROVED",
    module: "FINANCE",
    description: `Checker approved Expenditure ${String(doc._id)} — final approval, payment ${doc.paymentStatus}.`,
    entityType: "Expenditure",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function rejectExpenditure(id: string, input: { reason: string }, context: ActorContext): Promise<ExpenditureDto> {
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION" && doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Expenditure is not pending any approval.");
  }
  const actorId = requireActorId(context);
  assertNotSelfApproving({ makerId: doc.makerId, verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot }, actorId);

  const isVerifierStage = doc.approvalStatus === "PENDING_VERIFICATION";
  if (isVerifierStage) {
    await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  } else {
    await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  }

  const previousStatus = doc.approvalStatus;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await releaseToParentPool(doc.sourcePools, session);

      doc.approvalStatus = isVerifierStage ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
      doc.rejectionReason = input.reason;
      doc.rejectedBy = actorId;
      doc.rejectedAt = new Date();
      doc.holdingAmount = 0;
      // §20 — payment is never initiated on rejection, no matter the stage.
      if (isVerifierStage) doc.verifierId = actorId;
      else doc.checkerId = actorId;
      doc.updatedBy = actorId;
      await doc.save({ session });

      await recordWorkflowEvent(
        { module: "EXPENDITURE", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.totalWithTax },
        {
          action: isVerifierStage ? "VERIFIER_REJECTED" : "CHECKER_REJECTED",
          userId: actorId,
          userRole: isVerifierStage ? "Verifier" : "Checker",
          previousStatus,
          newStatus: doc.approvalStatus,
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
    action: isVerifierStage ? "EXPENDITURE_REJECTED_BY_VERIFIER" : "EXPENDITURE_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected Expenditure ${String(doc._id)}: ${input.reason} — Holding released.`,
    entityType: "Expenditure",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

// ---------------------------------------------------------------------------
// Listing / export / pending-approvals / attachments
// ---------------------------------------------------------------------------

function buildListMatch(query: ExpenditureListQuery | ExpenditureExportQuery, allowedNodeIds?: string[] | null): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (query.beneficiaryType) match.beneficiaryType = query.beneficiaryType;
  if (query.beneficiaryId) match.beneficiaryId = new Types.ObjectId(query.beneficiaryId);
  if (query.organizationNodeId) match.organizationNodeId = new Types.ObjectId(query.organizationNodeId);
  if (query.schemeHeadRootNodeId) match.schemeHeadRootNodeId = new Types.ObjectId(query.schemeHeadRootNodeId);
  if (query.headId) match.headId = new Types.ObjectId(query.headId);
  if (query.financialYearId) match.financialYearId = new Types.ObjectId(query.financialYearId);
  if (query.approvalStatus) match.approvalStatus = query.approvalStatus;
  if (query.paymentStatus) match.paymentStatus = query.paymentStatus;
  if (query.dateFrom || query.dateTo) {
    const billVoucherDate: Record<string, Date> = {};
    if (query.dateFrom) billVoucherDate.$gte = query.dateFrom;
    if (query.dateTo) billVoucherDate.$lte = query.dateTo;
    match.billVoucherDate = billVoucherDate;
  }
  if (query.amountFrom !== undefined || query.amountTo !== undefined) {
    const netPayableAmount: Record<string, number> = {};
    if (query.amountFrom !== undefined) netPayableAmount.$gte = query.amountFrom;
    if (query.amountTo !== undefined) netPayableAmount.$lte = query.amountTo;
    match.netPayableAmount = netPayableAmount;
  }

  const andConditions: Record<string, unknown>[] = [];
  if (allowedNodeIds) andConditions.push({ organizationNodeId: { $in: allowedNodeIds.map((id) => new Types.ObjectId(id)) } });
  if (query.search) {
    const regex = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    andConditions.push({ $or: [{ billVoucherNumber: regex }, { "beneficiarySnapshot.name": regex }, { remarks: regex }] });
  }
  if (andConditions.length > 0) match.$and = andConditions;
  return match;
}

export async function listExpenditures(query: ExpenditureListQuery, allowedNodeIds: string[] | null): Promise<ListResult<ExpenditureDto>> {
  const match = buildListMatch(query, allowedNodeIds);
  const [docs, total] = await Promise.all([
    ExpenditureModel.find(match)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    ExpenditureModel.countDocuments(match),
  ]);
  const maps = await buildLookupMaps();
  return {
    items: docs.map((doc) => serialize(doc, maps)),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getExpenditureCursorForExport(query: ExpenditureExportQuery, allowedNodeIds: string[] | null) {
  const match = buildListMatch(query, allowedNodeIds);
  return ExpenditureModel.find(match)
    .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
    .cursor();
}

export async function getExpenditureById(id: string, allowedNodeIds: string[] | null): Promise<ExpenditureDto> {
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");
  if (allowedNodeIds && !allowedNodeIds.includes(String(doc.organizationNodeId))) {
    throw new AppError(404, "Expenditure not found.");
  }
  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function listPendingExpenditureApprovalsForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: ExpenditureListQuery
): Promise<ListResult<ExpenditureDto>> {
  const actionableNodeIds = await getMyActionableNodeIds(actor, stage);
  const allowedNodeIds = actionableNodeIds === "ALL" ? null : actionableNodeIds;

  if (query.organizationNodeId && allowedNodeIds && !allowedNodeIds.includes(query.organizationNodeId)) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }
  if (allowedNodeIds && allowedNodeIds.length === 0) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }

  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  return listExpenditures({ ...query, approvalStatus: forcedStatus }, allowedNodeIds);
}

export function getAllowedNodeIdsForExpenditure(actor: ActorForPermission) {
  return getAllowedNodeIdsForList(actor);
}

export async function addExpenditureDocument(
  id: string,
  documentInfo: string | undefined,
  file: Express.Multer.File,
  context: ActorContext
): Promise<ExpenditureDto> {
  const doc = await ExpenditureModel.findById(id);
  if (!doc) throw new AppError(404, "Expenditure not found.");

  doc.attachments.push({
    documentInfo: documentInfo?.trim() || null,
    fileName: file.filename,
    originalName: file.originalname,
    fileUrl: `/uploads/expenditures/${file.filename}`,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: context.actorId,
    uploadedAt: new Date(),
  } as never);
  doc.updatedBy = context.actorId;
  await doc.save();

  await logActivity({
    user: context.actorId,
    action: "EXPENDITURE_DOCUMENT_UPLOADED",
    module: "FINANCE",
    description: `Uploaded document "${file.originalname}" to Expenditure ${String(doc._id)}.`,
    entityType: "Expenditure",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}
