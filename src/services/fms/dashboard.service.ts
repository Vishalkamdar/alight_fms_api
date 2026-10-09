import mongoose, { Types } from "mongoose";
import { ExpenditureModel } from "../../models/fms/Expenditure";
import { PayrollBatchModel } from "../../models/fms/PayrollBatch";
import { BudgetAllocationModel } from "../../models/fms/BudgetAllocation";
import { BudgetSetupModel } from "../../models/fms/BudgetSetup";
import { FundTransferModel } from "../../models/fms/FundTransfer";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { UserModel } from "../../models/User";
import type { FinancialYearDocument } from "../../models/fms/FinancialYear";
import { getMyActionableNodeIds } from "./financial-workflow.service";
import { operationalRoleForSystemRole } from "../../utils/fms/node-permission";
import {
  PENDING_STATUSES,
  REJECTED_STATUSES,
  FISCAL_MONTHS_FULL,
  toObjectIds,
  nodeFilter,
  headFilter,
  sumField,
  countAndSum,
  resolveEffectiveNodeIds,
  resolveEffectiveHeadIds,
  resolveHeadRootIds,
  resolveFinancialYear,
  buildFiscalTrendFromMonthKeys,
  resolveNames,
  type ReportActorContext,
} from "./report-aggregation.service";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import type { DashboardQuery } from "../../schemas/fms/dashboard.schema";

type ActorContext = ReportActorContext;

// ---------------------------------------------------------------------------
// §2 — Top budget KPIs
// ---------------------------------------------------------------------------

export interface BudgetKpis {
  totalBudget: number;
  allocated: number;
  available: number;
  onHold: number;
  totalExpenditure: number;
  totalPayroll: number;
}

export async function getBudgetKpis(
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null = null
): Promise<BudgetKpis> {
  // headFilter defaults to the "headId" field, present on Expenditure,
  // BudgetAllocation, and FundTransfer. BudgetSetup uses "schemeHeadNodeId"
  // instead. PayrollBatch has neither — only a root-pool
  // "schemeHeadRootNodeId" — so a Head restriction narrows Payroll by
  // resolving each restricted head up to its own scheme root first.
  const headMatch = headFilter(effectiveHeadIds);
  const headMatchSetup = headFilter(effectiveHeadIds, "schemeHeadNodeId");
  const payrollHeadRootIds = effectiveHeadIds === null ? null : await resolveHeadRootIds(effectiveHeadIds);
  const payrollHeadMatch = headFilter(payrollHeadRootIds, "schemeHeadRootNodeId");

  // Budget Setup records only ever exist at a root node, but that's never a
  // reason to widen a node-scoped user's own "Total Budget" up to the whole
  // org's root pool (§1 — a child's scope must never implicitly include its
  // parent's data) — filter on effectiveNodeIds directly, same as every
  // other field here. A non-root-assigned user correctly sees 0 here; they
  // have no Budget Setup pool of their own, only what's been allocated to
  // them (see `allocated`/`available` below).
  const totalBudget = await sumField(BudgetSetupModel, "originalAmount", {
    financialYearId: fyObjectId,
    ...nodeFilter(effectiveNodeIds, "organizationNodeId"),
    ...headMatchSetup,
  });

  const [allocationAgg] = await BudgetAllocationModel.aggregate<{ _id: null; amount: number; subAllocated: number }>([
    { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeFilter(effectiveNodeIds), ...headMatch } },
    { $group: { _id: null, amount: { $sum: "$amount" }, subAllocated: { $sum: "$subAllocatedAmount" } } },
  ]);
  const allocated = allocationAgg?.amount ?? 0;
  // subAllocatedAmount already nets out BOTH child sub-allocations AND
  // Expenditure/Payroll reservations (reserveFromNodeOwnReceivedPool
  // increments it directly) — Available never re-subtracts On Hold a
  // second time, so it can never be shown larger than what's truly free.
  const available = allocated - (allocationAgg?.subAllocated ?? 0);

  const pendingMatch = { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES } };
  const [onHoldExpenditure, onHoldPayroll, onHoldAllocation, onHoldSetup, onHoldTransfer] = await Promise.all([
    sumField(ExpenditureModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds), ...headMatch }),
    sumField(PayrollBatchModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds), ...payrollHeadMatch }),
    sumField(BudgetAllocationModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds), ...headMatch }),
    sumField(BudgetSetupModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds, "organizationNodeId"), ...headMatchSetup }),
    sumField(FundTransferModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds, "destinationNodeId"), ...headMatch }),
  ]);
  const onHold = onHoldExpenditure + onHoldPayroll + onHoldAllocation + onHoldSetup + onHoldTransfer;

  const [totalExpenditure, totalPayroll] = await Promise.all([
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds), ...headMatch }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds), ...payrollHeadMatch }),
  ]);

  return { totalBudget, allocated, available, onHold, totalExpenditure, totalPayroll };
}

// ---------------------------------------------------------------------------
// §3 — Role-adaptive approval KPI cards
// ---------------------------------------------------------------------------

export interface ApprovalKpiCard {
  label: string;
  value: number;
  amount: number;
}
export interface ApprovalKpis {
  role: "Maker" | "Verifier" | "Checker" | "Admin";
  cards: ApprovalKpiCard[];
}

interface ModuleSpec {
  model: mongoose.Model<any>;
  amountField: string;
}
const APPROVAL_MODULES: ModuleSpec[] = [
  { model: ExpenditureModel, amountField: "netPayableAmount" },
  { model: PayrollBatchModel, amountField: "totalNetSalary" },
  { model: BudgetAllocationModel, amountField: "amount" },
  { model: BudgetSetupModel, amountField: "originalAmount" },
];

async function sumAcrossApprovalModules(extraMatch: Record<string, unknown>): Promise<{ count: number; amount: number }> {
  const results = await Promise.all(APPROVAL_MODULES.map((spec) => countAndSum(spec.model, extraMatch, spec.amountField)));
  return results.reduce((acc, r) => ({ count: acc.count + r.count, amount: acc.amount + r.amount }), { count: 0, amount: 0 });
}

function toCard(label: string, result: { count: number; amount: number }): ApprovalKpiCard {
  return { label, value: result.count, amount: result.amount };
}

async function getMakerApprovalKpis(actor: ActorContext, fyObjectId: Types.ObjectId): Promise<ApprovalKpis> {
  const base = { financialYearId: fyObjectId, makerId: actor.actorId };
  const [submitted, pendingSubmission, rejected] = await Promise.all([
    sumAcrossApprovalModules(base),
    sumAcrossApprovalModules({ ...base, approvalStatus: { $in: PENDING_STATUSES } }),
    sumAcrossApprovalModules({ ...base, approvalStatus: { $in: REJECTED_STATUSES } }),
  ]);
  return { role: "Maker", cards: [toCard("Submitted", submitted), toCard("Pending Submission", pendingSubmission), toCard("Rejected", rejected)] };
}

async function getVerifierOrCheckerApprovalKpis(actor: ActorContext, fyObjectId: Types.ObjectId, role: "Verifier" | "Checker"): Promise<ApprovalKpis> {
  const actionableNodeIds = await getMyActionableNodeIds(actor, role);
  const nodeMatch = actionableNodeIds === "ALL" ? {} : { organizationNodeId: { $in: toObjectIds(actionableNodeIds) } };
  const pendingStatus = role === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  const rejectedStatus = role === "Verifier" ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
  const progressedStatuses = role === "Verifier" ? ["PENDING_CHECKER_APPROVAL", "APPROVED"] : ["APPROVED"];
  const identityField = role === "Verifier" ? "verifierId" : "checkerId";

  const [pending, progressed, rejected] = await Promise.all([
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: pendingStatus, ...nodeMatch }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, [identityField]: actor.actorId, approvalStatus: { $in: progressedStatuses } }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, [identityField]: actor.actorId, approvalStatus: rejectedStatus }),
  ]);

  return {
    role,
    cards: [
      toCard(role === "Verifier" ? "Pending Verification" : "Pending Checker Approval", pending),
      toCard(role === "Verifier" ? "Verified" : "Approved", progressed),
      toCard("Rejected", rejected),
    ],
  };
}

async function getAdminApprovalKpis(fyObjectId: Types.ObjectId, effectiveNodeIds: string[] | null): Promise<ApprovalKpis> {
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const [pendingVerification, pendingChecker, approved, rejected] = await Promise.all([
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "PENDING_VERIFICATION", ...nodeMatch }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "PENDING_CHECKER_APPROVAL", ...nodeMatch }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES }, ...nodeMatch }),
  ]);
  return {
    role: "Admin",
    cards: [
      toCard("Pending Verification", pendingVerification),
      toCard("Pending Checker Approval", pendingChecker),
      toCard("Approved", approved),
      toCard("Rejected", rejected),
    ],
  };
}

function effectiveFmsRole(actor: ActorContext): "Maker" | "Verifier" | "Checker" | "Admin" {
  if (actor.actorRole === "Super Admin" || actor.actorRole === "Admin") return "Admin";
  const fmsRole = operationalRoleForSystemRole(actor.actorRole);
  if (fmsRole === "Verifier" || fmsRole === "Checker") return fmsRole;
  return "Maker";
}

async function getApprovalKpis(actor: ActorContext, fyObjectId: Types.ObjectId, effectiveNodeIds: string[] | null): Promise<ApprovalKpis> {
  const role = effectiveFmsRole(actor);
  if (role === "Admin") return getAdminApprovalKpis(fyObjectId, effectiveNodeIds);
  if (role === "Verifier" || role === "Checker") return getVerifierOrCheckerApprovalKpis(actor, fyObjectId, role);
  return getMakerApprovalKpis(actor, fyObjectId);
}

// ---------------------------------------------------------------------------
// §4 — Pending Approvals per module
// ---------------------------------------------------------------------------

export interface PendingApprovalCounts {
  expenditure: number;
  payroll: number;
  budgetAllocation: number;
  budgetSetup: number;
  total: number;
}

async function countPerModule(match: Record<string, unknown>): Promise<PendingApprovalCounts> {
  const [expenditure, payroll, budgetAllocation, budgetSetup] = await Promise.all([
    ExpenditureModel.countDocuments(match),
    PayrollBatchModel.countDocuments(match),
    BudgetAllocationModel.countDocuments(match),
    BudgetSetupModel.countDocuments(match),
  ]);
  return { expenditure, payroll, budgetAllocation, budgetSetup, total: expenditure + payroll + budgetAllocation + budgetSetup };
}

async function getPendingApprovalCounts(
  actor: ActorContext,
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null
): Promise<PendingApprovalCounts> {
  const role = effectiveFmsRole(actor);

  if (role === "Verifier" || role === "Checker") {
    const actionableNodeIds = await getMyActionableNodeIds(actor, role);
    const nodeMatch = actionableNodeIds === "ALL" ? {} : { organizationNodeId: { $in: toObjectIds(actionableNodeIds) } };
    const status = role === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
    return countPerModule({ financialYearId: fyObjectId, approvalStatus: status, ...nodeMatch });
  }
  if (role === "Admin") {
    return countPerModule({ financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeFilter(effectiveNodeIds) });
  }
  // Maker — their own entries still awaiting Verifier/Checker action.
  return countPerModule({ financialYearId: fyObjectId, makerId: actor.actorId, approvalStatus: { $in: PENDING_STATUSES } });
}

// ---------------------------------------------------------------------------
// §6 — Organization Node Summary (multi-node users only)
// ---------------------------------------------------------------------------

export interface NodeSummaryRow {
  organizationNodeId: string;
  nodeName: string;
  budget: number;
  allocated: number;
  available: number;
  onHold: number;
  expenditure: number;
}

/**
 * The per-node Budget/Expenditure/On-Hold breakdown shared by the
 * Dashboard's node-summary widget AND the Reports module's Budget Summary /
 * Organization Node Financial reports — one implementation, two callers.
 * `nodeIds === null` returns every Active node; otherwise exactly the
 * requested set (regardless of count — callers decide whether "only show
 * for >1 node" applies to them).
 */
export async function computeNodeFinancialSummaries(
  fyObjectId: Types.ObjectId,
  nodeIds: string[] | null,
  headIds: string[] | null = null
): Promise<NodeSummaryRow[]> {
  const nodeMatch = nodeFilter(nodeIds);
  const headMatch = headFilter(headIds);
  const [allocationRows, expenditureRows, onHoldExpRows, onHoldAllocRows, nodes] = await Promise.all([
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number; subAllocated: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch, ...headMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$amount" }, subAllocated: { $sum: "$subAllocatedAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$netPayableAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$holdingAmount" } } },
    ]),
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$holdingAmount" } } },
    ]),
    OrganizationNodeModel.find(nodeIds === null ? { status: "Active" } : { _id: { $in: toObjectIds(nodeIds) } })
      .select("_id name")
      .lean(),
  ]);

  const allocationMap = new Map(allocationRows.map((r) => [String(r._id), r]));
  const expenditureMap = new Map(expenditureRows.map((r) => [String(r._id), r.amount]));
  const onHoldMap = new Map<string, number>();
  for (const r of [...onHoldExpRows, ...onHoldAllocRows]) {
    const key = String(r._id);
    onHoldMap.set(key, (onHoldMap.get(key) ?? 0) + r.amount);
  }

  return nodes.map((node) => {
    const nodeId = String(node._id);
    const allocation = allocationMap.get(nodeId);
    const allocated = allocation?.amount ?? 0;
    return {
      organizationNodeId: nodeId,
      nodeName: node.name,
      // A node's own "Budget" ceiling is what it was allocated — BudgetSetup
      // is a root-level pool, not broken down per department.
      budget: allocated,
      allocated,
      available: allocated - (allocation?.subAllocated ?? 0),
      onHold: onHoldMap.get(nodeId) ?? 0,
      expenditure: expenditureMap.get(nodeId) ?? 0,
    };
  });
}

async function getNodeSummaries(
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null
): Promise<NodeSummaryRow[] | null> {
  if (effectiveNodeIds !== null && effectiveNodeIds.length <= 1) return null;
  return computeNodeFinancialSummaries(fyObjectId, effectiveNodeIds, effectiveHeadIds);
}

// ---------------------------------------------------------------------------
// §3b — Head-Wise Financial Summary (combined node+head filter, multi-head
// users only) — mirrors computeNodeFinancialSummaries/getNodeSummaries
// exactly, grouped by Head instead of Organization Node.
// ---------------------------------------------------------------------------

export interface HeadSummaryRow {
  headId: string;
  headName: string;
  allocated: number;
  available: number;
  onHold: number;
  expenditure: number;
}

export async function computeHeadFinancialSummaries(
  fyObjectId: Types.ObjectId,
  nodeIds: string[] | null,
  headIds: string[] | null
): Promise<HeadSummaryRow[]> {
  const nodeMatch = nodeFilter(nodeIds);
  const headMatch = headFilter(headIds);
  const [allocationRows, expenditureRows, onHoldExpRows, onHoldAllocRows, heads] = await Promise.all([
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number; subAllocated: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch, ...headMatch } },
      { $group: { _id: "$headId", amount: { $sum: "$amount" }, subAllocated: { $sum: "$subAllocatedAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$headId", amount: { $sum: "$netPayableAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$headId", amount: { $sum: "$holdingAmount" } } },
    ]),
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$headId", amount: { $sum: "$holdingAmount" } } },
    ]),
    SchemeHeadNodeModel.find(headIds === null ? { status: "Active" } : { _id: { $in: toObjectIds(headIds) } })
      .select("_id name")
      .lean(),
  ]);

  const allocationMap = new Map(allocationRows.filter((r) => r._id).map((r) => [String(r._id), r]));
  const expenditureMap = new Map(expenditureRows.filter((r) => r._id).map((r) => [String(r._id), r.amount]));
  const onHoldMap = new Map<string, number>();
  for (const r of [...onHoldExpRows, ...onHoldAllocRows]) {
    if (!r._id) continue;
    const key = String(r._id);
    onHoldMap.set(key, (onHoldMap.get(key) ?? 0) + r.amount);
  }

  return heads.map((head) => {
    const headId = String(head._id);
    const allocation = allocationMap.get(headId);
    const allocated = allocation?.amount ?? 0;
    return {
      headId,
      headName: head.name,
      allocated,
      available: allocated - (allocation?.subAllocated ?? 0),
      onHold: onHoldMap.get(headId) ?? 0,
      expenditure: expenditureMap.get(headId) ?? 0,
    };
  });
}

async function getHeadSummaries(
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null
): Promise<HeadSummaryRow[] | null> {
  if (effectiveHeadIds !== null && effectiveHeadIds.length <= 1) return null;
  return computeHeadFinancialSummaries(fyObjectId, effectiveNodeIds, effectiveHeadIds);
}

// ---------------------------------------------------------------------------
// §7/§8 — Expenditure / Payroll Overview
// ---------------------------------------------------------------------------

export interface OverviewTrendPoint {
  month: string;
  amount: number;
}
export interface ExpenditureOverview {
  thisMonth: number;
  approved: number;
  pending: number;
  paid: number;
  trend: OverviewTrendPoint[];
}
export interface PayrollOverview {
  currentMonthPayroll: number;
  employees: number;
  pendingApproval: number;
  paid: number;
  trend: OverviewTrendPoint[];
}

export async function getExpenditureOverview(
  fy: FinancialYearDocument,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null = null
): Promise<ExpenditureOverview> {
  const fyObjectId = fy._id;
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const headMatch = headFilter(effectiveHeadIds);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [thisMonth, approved, pending, paid, trendRows] = await Promise.all([
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, billVoucherDate: { $gte: startOfMonth }, ...nodeMatch, ...headMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch, ...headMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, paymentStatus: "PAYMENT_SUCCESS", ...nodeMatch, ...headMatch }),
    ExpenditureModel.aggregate<{ _id: string; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch, ...headMatch } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$billVoucherDate", timezone: "UTC" } }, amount: { $sum: "$netPayableAmount" } } },
    ]),
  ]);

  const trendByMonthKey = new Map(trendRows.map((r) => [r._id, r.amount]));
  return { thisMonth, approved, pending, paid, trend: buildFiscalTrendFromMonthKeys(fy.startDate, trendByMonthKey) };
}

export async function getPayrollOverview(
  fy: FinancialYearDocument,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null = null
): Promise<PayrollOverview> {
  const fyObjectId = fy._id;
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const payrollHeadRootIds = effectiveHeadIds === null ? null : await resolveHeadRootIds(effectiveHeadIds);
  const headMatch = headFilter(payrollHeadRootIds, "schemeHeadRootNodeId");
  const currentMonthName = new Date().toLocaleString("en-US", { month: "long" });

  const [currentMonthPayroll, pendingApproval, paid, trendRows, employeeAgg] = await Promise.all([
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, month: currentMonthName, ...nodeMatch, ...headMatch }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch, ...headMatch }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, paymentStatus: "PAYMENT_SUCCESS", ...nodeMatch, ...headMatch }),
    PayrollBatchModel.aggregate<{ _id: string; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch, ...headMatch } },
      { $group: { _id: "$month", amount: { $sum: "$totalNetSalary" } } },
    ]),
    PayrollBatchModel.aggregate<{ _id: null; employeeIds: Types.ObjectId[] }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch, ...headMatch } },
      { $unwind: "$employees" },
      { $group: { _id: null, employeeIds: { $addToSet: "$employees.beneficiaryId" } } },
    ]),
  ]);

  const trendByMonth = new Map(trendRows.map((r) => [r._id, r.amount]));
  const trend = FISCAL_MONTHS_FULL.map((month) => ({ month: month.slice(0, 3), amount: trendByMonth.get(month) ?? 0 }));
  const employees = employeeAgg[0]?.employeeIds?.length ?? 0;

  return { currentMonthPayroll, employees, pendingApproval, paid, trend };
}

// ---------------------------------------------------------------------------
// §9 — Recent Transactions (merged across modules, re-sorted, sliced)
// ---------------------------------------------------------------------------

export interface RecentTransaction {
  date: Date;
  module: string;
  transactionNumber: string;
  organizationNode: string;
  beneficiary: string;
  amount: number;
  status: string;
  createdBy: string;
}

interface RecentTransactionFilters {
  module?: string;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

async function getRecentTransactions(
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  filters: RecentTransactionFilters,
  limit = 20
): Promise<RecentTransaction[]> {
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const dateRange: Record<string, Date> = {};
  if (filters.dateFrom) dateRange.$gte = filters.dateFrom;
  if (filters.dateTo) dateRange.$lte = filters.dateTo;
  const wants = (moduleKey: string) => !filters.module || filters.module === moduleKey;

  const results: RecentTransaction[] = [];

  if (wants("EXPENDITURE")) {
    const match: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeMatch };
    if (filters.status) match.approvalStatus = filters.status;
    if (Object.keys(dateRange).length > 0) match.billVoucherDate = dateRange;
    const docs = await ExpenditureModel.find(match)
      .sort({ billVoucherDate: -1 })
      .limit(limit)
      .select("billVoucherDate billVoucherNumber organizationNodeId beneficiarySnapshot netPayableAmount approvalStatus createdBy")
      .lean();
    const [nodeNames, userNames] = await Promise.all([
      resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
      resolveNames(UserModel, docs.map((d) => d.createdBy), "fullname"),
    ]);
    results.push(
      ...docs.map((d) => ({
        date: d.billVoucherDate,
        module: "Expenditure",
        transactionNumber: d.billVoucherNumber,
        organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
        beneficiary: d.beneficiarySnapshot.name,
        amount: d.netPayableAmount,
        status: d.approvalStatus,
        createdBy: d.createdBy ? userNames.get(String(d.createdBy)) ?? "" : "",
      }))
    );
  }

  if (wants("PAYROLL")) {
    const match: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeMatch };
    if (filters.status) match.approvalStatus = filters.status;
    if (Object.keys(dateRange).length > 0) match.createdAt = dateRange;
    const docs = await PayrollBatchModel.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("createdAt payrollNumber organizationNodeId employees totalNetSalary approvalStatus createdBy")
      .lean();
    const [nodeNames, userNames] = await Promise.all([
      resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
      resolveNames(UserModel, docs.map((d) => d.createdBy), "fullname"),
    ]);
    results.push(
      ...docs.map((d) => ({
        date: d.createdAt,
        module: "Payroll",
        transactionNumber: d.payrollNumber,
        organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
        beneficiary: `${d.employees.length} employee${d.employees.length === 1 ? "" : "s"}`,
        amount: d.totalNetSalary,
        status: d.approvalStatus,
        createdBy: d.createdBy ? userNames.get(String(d.createdBy)) ?? "" : "",
      }))
    );
  }

  if (wants("BUDGET_ALLOCATION")) {
    const match: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeMatch };
    if (filters.status) match.approvalStatus = filters.status;
    if (Object.keys(dateRange).length > 0) match.createdAt = dateRange;
    const docs = await BudgetAllocationModel.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("createdAt organizationNodeId amount approvalStatus createdBy")
      .lean();
    const [nodeNames, userNames] = await Promise.all([
      resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
      resolveNames(UserModel, docs.map((d) => d.createdBy), "fullname"),
    ]);
    results.push(
      ...docs.map((d) => ({
        date: d.createdAt,
        module: "Budget Allocation",
        transactionNumber: String(d._id),
        organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
        beneficiary: "—",
        amount: d.amount,
        status: d.approvalStatus,
        createdBy: d.createdBy ? userNames.get(String(d.createdBy)) ?? "" : "",
      }))
    );
  }

  if (wants("BUDGET_SETUP")) {
    const match: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeMatch };
    if (filters.status) match.approvalStatus = filters.status;
    if (Object.keys(dateRange).length > 0) match.createdAt = dateRange;
    const docs = await BudgetSetupModel.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("createdAt organizationNodeId originalAmount approvalStatus createdBy")
      .lean();
    const [nodeNames, userNames] = await Promise.all([
      resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
      resolveNames(UserModel, docs.map((d) => d.createdBy), "fullname"),
    ]);
    results.push(
      ...docs.map((d) => ({
        date: d.createdAt,
        module: "Budget Setup",
        transactionNumber: String(d._id),
        organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
        beneficiary: "—",
        amount: d.originalAmount,
        status: d.approvalStatus,
        createdBy: d.createdBy ? userNames.get(String(d.createdBy)) ?? "" : "",
      }))
    );
  }

  results.sort((a, b) => b.date.getTime() - a.date.getTime());
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// §11 — Alerts & Exceptions (purely derived from real conditions above)
// ---------------------------------------------------------------------------

export interface DashboardAlert {
  severity: "warning" | "critical";
  message: string;
  module: string;
}

function buildBudgetAlerts(budgetKpis: BudgetKpis, pendingApprovals: PendingApprovalCounts, nodeSummaries: NodeSummaryRow[] | null): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  if (budgetKpis.allocated > 0 && budgetKpis.available <= 0) {
    alerts.push({ severity: "critical", message: "Insufficient available budget — allocated funds are fully committed.", module: "Budget" });
  } else if (budgetKpis.allocated > 0 && budgetKpis.available / budgetKpis.allocated < 0.1) {
    alerts.push({ severity: "warning", message: "Budget nearing limit — less than 10% of allocated funds remain available.", module: "Budget" });
  }
  if (budgetKpis.allocated > 0 && budgetKpis.onHold / budgetKpis.allocated > 0.3) {
    alerts.push({ severity: "warning", message: "A large share of allocated funds is currently On Hold pending approval.", module: "Budget" });
  }
  if (pendingApprovals.expenditure > 0) alerts.push({ severity: "warning", message: `${pendingApprovals.expenditure} Expenditure record(s) pending your action.`, module: "Expenditure" });
  if (pendingApprovals.payroll > 0) alerts.push({ severity: "warning", message: `${pendingApprovals.payroll} Payroll batch(es) pending your action.`, module: "Payroll" });
  if (pendingApprovals.budgetAllocation > 0) alerts.push({ severity: "warning", message: `${pendingApprovals.budgetAllocation} Budget Allocation(s) pending your action.`, module: "Budget Allocation" });
  if (pendingApprovals.budgetSetup > 0) alerts.push({ severity: "warning", message: `${pendingApprovals.budgetSetup} Budget Setup(s) pending your action.`, module: "Budget Setup" });

  if (nodeSummaries) {
    for (const row of nodeSummaries) {
      if (row.allocated > 0 && row.available <= 0) {
        alerts.push({ severity: "critical", message: `"${row.nodeName}" has no available budget remaining.`, module: "Budget" });
      }
    }
  }
  return alerts;
}

async function getExceptionAlerts(
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  effectiveHeadIds: string[] | null = null
): Promise<DashboardAlert[]> {
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const headMatch = headFilter(effectiveHeadIds);
  const payrollHeadRootIds = effectiveHeadIds === null ? null : await resolveHeadRootIds(effectiveHeadIds);
  const payrollHeadMatch = headFilter(payrollHeadRootIds, "schemeHeadRootNodeId");
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const [failedExpenditure, failedPayroll, rejectedExpenditure, rejectedPayroll, unprocessedPayroll] = await Promise.all([
    ExpenditureModel.countDocuments({ financialYearId: fyObjectId, paymentStatus: "PAYMENT_FAILED", ...nodeMatch, ...headMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, paymentStatus: "PAYMENT_FAILED", ...nodeMatch, ...payrollHeadMatch }),
    ExpenditureModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES }, updatedAt: { $gte: thirtyDaysAgo }, ...nodeMatch, ...headMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES }, updatedAt: { $gte: thirtyDaysAgo }, ...nodeMatch, ...payrollHeadMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: "APPROVED", paymentStatus: { $ne: "PAYMENT_SUCCESS" }, approvedAt: { $lte: twoDaysAgo }, ...nodeMatch, ...payrollHeadMatch }),
  ]);

  const alerts: DashboardAlert[] = [];
  if (failedExpenditure > 0) alerts.push({ severity: "critical", message: `${failedExpenditure} Expenditure payment(s) failed.`, module: "Expenditure" });
  if (failedPayroll > 0) alerts.push({ severity: "critical", message: `${failedPayroll} Payroll payment(s) failed.`, module: "Payroll" });
  if (rejectedExpenditure > 0) alerts.push({ severity: "warning", message: `${rejectedExpenditure} Expenditure record(s) rejected in the last 30 days.`, module: "Expenditure" });
  if (rejectedPayroll > 0) alerts.push({ severity: "warning", message: `${rejectedPayroll} Payroll batch(es) rejected in the last 30 days.`, module: "Payroll" });
  if (unprocessedPayroll > 0) alerts.push({ severity: "warning", message: `${unprocessedPayroll} approved Payroll batch(es) still unpaid after 2+ days.`, module: "Payroll" });
  return alerts;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DashboardDto {
  scope: { organizationNodeId: string | null; headId: string | null };
  financialYear: { _id: string; financialYear: string };
  budgetKpis: BudgetKpis;
  approvalKpis: ApprovalKpis;
  pendingApprovals: PendingApprovalCounts;
  nodeSummaries: NodeSummaryRow[] | null;
  headSummaries: HeadSummaryRow[] | null;
  expenditureOverview: ExpenditureOverview;
  payrollOverview: PayrollOverview;
  recentTransactions: RecentTransaction[];
  alerts: DashboardAlert[];
}

export async function getDashboardData(query: DashboardQuery, actor: ActorContext): Promise<DashboardDto> {
  const fy = await resolveFinancialYear(query.financialYearId);
  const fyObjectId = fy._id;
  const effectiveNodeIds = await resolveEffectiveNodeIds(actor, query.organizationNodeId);
  const effectiveHeadIds = await resolveEffectiveHeadIds(actor, query.headId);

  const [budgetKpis, approvalKpis, pendingApprovals, nodeSummaries, headSummaries, expenditureOverview, payrollOverview, recentTransactions, exceptionAlerts] = await Promise.all([
    getBudgetKpis(fyObjectId, effectiveNodeIds, effectiveHeadIds),
    getApprovalKpis(actor, fyObjectId, effectiveNodeIds),
    getPendingApprovalCounts(actor, fyObjectId, effectiveNodeIds),
    getNodeSummaries(fyObjectId, effectiveNodeIds, effectiveHeadIds),
    getHeadSummaries(fyObjectId, effectiveNodeIds, effectiveHeadIds),
    getExpenditureOverview(fy, effectiveNodeIds, effectiveHeadIds),
    getPayrollOverview(fy, effectiveNodeIds, effectiveHeadIds),
    getRecentTransactions(fyObjectId, effectiveNodeIds, {
      module: query.module,
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    }),
    getExceptionAlerts(fyObjectId, effectiveNodeIds, effectiveHeadIds),
  ]);

  const alerts = [...buildBudgetAlerts(budgetKpis, pendingApprovals, nodeSummaries), ...exceptionAlerts];

  return {
    scope: { organizationNodeId: query.organizationNodeId ?? null, headId: query.headId ?? null },
    financialYear: { _id: String(fy._id), financialYear: fy.financialYear },
    budgetKpis,
    approvalKpis,
    pendingApprovals,
    nodeSummaries,
    headSummaries,
    expenditureOverview,
    payrollOverview,
    recentTransactions,
    alerts,
  };
}
