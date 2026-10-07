import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { ExpenditureModel } from "../../models/fms/Expenditure";
import { PayrollBatchModel } from "../../models/fms/PayrollBatch";
import { BudgetAllocationModel } from "../../models/fms/BudgetAllocation";
import { BudgetSetupModel } from "../../models/fms/BudgetSetup";
import { FundTransferModel } from "../../models/fms/FundTransfer";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { UserModel, type UserRole } from "../../models/User";
import { FinancialYearModel, type FinancialYearDocument } from "../../models/fms/FinancialYear";
import { getCurrentFinancialYear } from "./financial-year.service";
import { getAllowedNodeIdsForList, getMyActionableNodeIds, type ActorForPermission } from "./financial-workflow.service";
import { operationalRoleForSystemRole } from "../../utils/fms/node-permission";
import type { DashboardQuery } from "../../schemas/fms/dashboard.schema";

interface ActorContext extends ActorForPermission {
  actorRole: UserRole;
}

const PENDING_STATUSES = ["PENDING_VERIFICATION", "PENDING_CHECKER_APPROVAL"] as const;
const REJECTED_STATUSES = ["REJECTED_BY_VERIFIER", "REJECTED_BY_CHECKER"] as const;
const FISCAL_MONTHS_FULL = [
  "April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March",
] as const;

function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.map((id) => new Types.ObjectId(id));
}

/** `null` = unrestricted (every node). A `string[]` always filters on `field`. */
function nodeFilter(nodeIds: string[] | null, field = "organizationNodeId"): Record<string, unknown> {
  if (nodeIds === null) return {};
  return { [field]: { $in: toObjectIds(nodeIds) } };
}

async function sumField(Model: mongoose.Model<any>, field: string, match: Record<string, unknown>): Promise<number> {
  const rows = await Model.aggregate<{ _id: null; sum: number }>([{ $match: match }, { $group: { _id: null, sum: { $sum: `$${field}` } } }]);
  return rows[0]?.sum ?? 0;
}

async function countAndSum(Model: mongoose.Model<any>, match: Record<string, unknown>, amountField: string): Promise<{ count: number; amount: number }> {
  const rows = await Model.aggregate<{ _id: null; count: number; amount: number }>([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: `$${amountField}` } } },
  ]);
  return { count: rows[0]?.count ?? 0, amount: rows[0]?.amount ?? 0 };
}

/** Every Organization Node a node id could resolve up to — in-memory walk, one query, no N+1 (same shape as Bulk Upload's resolveOrganizationRoot). */
async function resolveRootNodeIds(nodeIds: string[]): Promise<string[]> {
  const allNodes = await OrganizationNodeModel.find().select("_id parentNodeId").lean();
  const parentById = new Map(allNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));
  const roots = new Set<string>();
  for (const id of nodeIds) {
    let current = id;
    const visited = new Set<string>();
    while (parentById.get(current)) {
      if (visited.has(current)) break;
      visited.add(current);
      current = parentById.get(current)!;
    }
    roots.add(current);
  }
  return [...roots];
}

async function resolveEffectiveNodeIds(actor: ActorContext, requestedNodeId: string | undefined): Promise<string[] | null> {
  const allowed = await getAllowedNodeIdsForList(actor);
  if (!requestedNodeId) return allowed;
  if (allowed !== null && !allowed.includes(requestedNodeId)) {
    throw new AppError(403, "You do not have access to this Organization Node.");
  }
  return [requestedNodeId];
}

async function resolveFinancialYear(financialYearId: string | undefined): Promise<FinancialYearDocument> {
  if (!financialYearId) return getCurrentFinancialYear();
  const year = await FinancialYearModel.findById(financialYearId);
  if (!year) throw new AppError(404, "Financial Year not found.");
  return year;
}

function buildFiscalTrendFromMonthKeys(fyStartDate: Date, amountByMonthKey: Map<string, number>): Array<{ month: string; amount: number }> {
  const points: Array<{ month: string; amount: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(fyStartDate.getUTCFullYear(), fyStartDate.getUTCMonth() + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    points.push({ month: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }), amount: amountByMonthKey.get(key) ?? 0 });
  }
  return points;
}

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

async function getBudgetKpis(fyObjectId: Types.ObjectId, effectiveNodeIds: string[] | null): Promise<BudgetKpis> {
  const rootNodeIds = effectiveNodeIds === null ? null : await resolveRootNodeIds(effectiveNodeIds);

  const totalBudget = await sumField(BudgetSetupModel, "originalAmount", {
    financialYearId: fyObjectId,
    ...nodeFilter(rootNodeIds, "organizationNodeId"),
  });

  const [allocationAgg] = await BudgetAllocationModel.aggregate<{ _id: null; amount: number; subAllocated: number }>([
    { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeFilter(effectiveNodeIds) } },
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
    sumField(ExpenditureModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds) }),
    sumField(PayrollBatchModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds) }),
    sumField(BudgetAllocationModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds) }),
    sumField(BudgetSetupModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(rootNodeIds, "organizationNodeId") }),
    sumField(FundTransferModel, "holdingAmount", { ...pendingMatch, ...nodeFilter(effectiveNodeIds, "destinationNodeId") }),
  ]);
  const onHold = onHoldExpenditure + onHoldPayroll + onHoldAllocation + onHoldSetup + onHoldTransfer;

  const [totalExpenditure, totalPayroll] = await Promise.all([
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds) }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds) }),
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

async function getAdminApprovalKpis(fyObjectId: Types.ObjectId): Promise<ApprovalKpis> {
  const [pendingVerification, pendingChecker, approved, rejected] = await Promise.all([
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "PENDING_VERIFICATION" }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "PENDING_CHECKER_APPROVAL" }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: "APPROVED" }),
    sumAcrossApprovalModules({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES } }),
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

async function getApprovalKpis(actor: ActorContext, fyObjectId: Types.ObjectId): Promise<ApprovalKpis> {
  const role = effectiveFmsRole(actor);
  if (role === "Admin") return getAdminApprovalKpis(fyObjectId);
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

async function getPendingApprovalCounts(actor: ActorContext, fyObjectId: Types.ObjectId): Promise<PendingApprovalCounts> {
  const role = effectiveFmsRole(actor);

  if (role === "Verifier" || role === "Checker") {
    const actionableNodeIds = await getMyActionableNodeIds(actor, role);
    const nodeMatch = actionableNodeIds === "ALL" ? {} : { organizationNodeId: { $in: toObjectIds(actionableNodeIds) } };
    const status = role === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
    return countPerModule({ financialYearId: fyObjectId, approvalStatus: status, ...nodeMatch });
  }
  if (role === "Admin") {
    return countPerModule({ financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES } });
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

async function getNodeSummaries(fyObjectId: Types.ObjectId, effectiveNodeIds: string[] | null): Promise<NodeSummaryRow[] | null> {
  if (effectiveNodeIds !== null && effectiveNodeIds.length <= 1) return null;

  const nodeMatch = nodeFilter(effectiveNodeIds);
  const [allocationRows, expenditureRows, onHoldExpRows, onHoldAllocRows, nodes] = await Promise.all([
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number; subAllocated: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$amount" }, subAllocated: { $sum: "$subAllocatedAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$netPayableAmount" } } },
    ]),
    ExpenditureModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$holdingAmount" } } },
    ]),
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$holdingAmount" } } },
    ]),
    OrganizationNodeModel.find(effectiveNodeIds === null ? { status: "Active" } : { _id: { $in: toObjectIds(effectiveNodeIds) } })
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

async function getExpenditureOverview(fy: FinancialYearDocument, effectiveNodeIds: string[] | null): Promise<ExpenditureOverview> {
  const fyObjectId = fy._id;
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [thisMonth, approved, pending, paid, trendRows] = await Promise.all([
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, billVoucherDate: { $gte: startOfMonth }, ...nodeMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, approvalStatus: "APPROVED", ...nodeMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, paymentStatus: "PAYMENT_SUCCESS", ...nodeMatch }),
    ExpenditureModel.aggregate<{ _id: string; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$billVoucherDate", timezone: "UTC" } }, amount: { $sum: "$netPayableAmount" } } },
    ]),
  ]);

  const trendByMonthKey = new Map(trendRows.map((r) => [r._id, r.amount]));
  return { thisMonth, approved, pending, paid, trend: buildFiscalTrendFromMonthKeys(fy.startDate, trendByMonthKey) };
}

async function getPayrollOverview(fy: FinancialYearDocument, effectiveNodeIds: string[] | null): Promise<PayrollOverview> {
  const fyObjectId = fy._id;
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const currentMonthName = new Date().toLocaleString("en-US", { month: "long" });

  const [currentMonthPayroll, pendingApproval, paid, trendRows, employeeAgg] = await Promise.all([
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, month: currentMonthName, ...nodeMatch }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES }, ...nodeMatch }),
    sumField(PayrollBatchModel, "totalNetSalary", { financialYearId: fyObjectId, paymentStatus: "PAYMENT_SUCCESS", ...nodeMatch }),
    PayrollBatchModel.aggregate<{ _id: string; amount: number }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch } },
      { $group: { _id: "$month", amount: { $sum: "$totalNetSalary" } } },
    ]),
    PayrollBatchModel.aggregate<{ _id: null; employeeIds: Types.ObjectId[] }>([
      { $match: { financialYearId: fyObjectId, ...nodeMatch } },
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

async function resolveNames(Model: mongoose.Model<any>, ids: Array<Types.ObjectId | null | undefined>, nameField: string): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map(String))];
  if (uniq.length === 0) return new Map();
  const docs = await Model.find({ _id: { $in: uniq } })
    .select(nameField)
    .lean();
  return new Map(docs.map((d) => [String((d as { _id: Types.ObjectId })._id), (d as Record<string, string>)[nameField]]));
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
    const match: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds === null ? null : await resolveRootNodeIds(effectiveNodeIds), "organizationNodeId") };
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

async function getExceptionAlerts(fyObjectId: Types.ObjectId, effectiveNodeIds: string[] | null): Promise<DashboardAlert[]> {
  const nodeMatch = nodeFilter(effectiveNodeIds);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const [failedExpenditure, failedPayroll, rejectedExpenditure, rejectedPayroll, unprocessedPayroll] = await Promise.all([
    ExpenditureModel.countDocuments({ financialYearId: fyObjectId, paymentStatus: "PAYMENT_FAILED", ...nodeMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, paymentStatus: "PAYMENT_FAILED", ...nodeMatch }),
    ExpenditureModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES }, updatedAt: { $gte: thirtyDaysAgo }, ...nodeMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: { $in: REJECTED_STATUSES }, updatedAt: { $gte: thirtyDaysAgo }, ...nodeMatch }),
    PayrollBatchModel.countDocuments({ financialYearId: fyObjectId, approvalStatus: "APPROVED", paymentStatus: { $ne: "PAYMENT_SUCCESS" }, approvedAt: { $lte: twoDaysAgo }, ...nodeMatch }),
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
  scope: { organizationNodeId: string | null };
  financialYear: { _id: string; financialYear: string };
  budgetKpis: BudgetKpis;
  approvalKpis: ApprovalKpis;
  pendingApprovals: PendingApprovalCounts;
  nodeSummaries: NodeSummaryRow[] | null;
  expenditureOverview: ExpenditureOverview;
  payrollOverview: PayrollOverview;
  recentTransactions: RecentTransaction[];
  alerts: DashboardAlert[];
}

export async function getDashboardData(query: DashboardQuery, actor: ActorContext): Promise<DashboardDto> {
  const fy = await resolveFinancialYear(query.financialYearId);
  const fyObjectId = fy._id;
  const effectiveNodeIds = await resolveEffectiveNodeIds(actor, query.organizationNodeId);

  const [budgetKpis, approvalKpis, pendingApprovals, nodeSummaries, expenditureOverview, payrollOverview, recentTransactions, exceptionAlerts] = await Promise.all([
    getBudgetKpis(fyObjectId, effectiveNodeIds),
    getApprovalKpis(actor, fyObjectId),
    getPendingApprovalCounts(actor, fyObjectId),
    getNodeSummaries(fyObjectId, effectiveNodeIds),
    getExpenditureOverview(fy, effectiveNodeIds),
    getPayrollOverview(fy, effectiveNodeIds),
    getRecentTransactions(fyObjectId, effectiveNodeIds, {
      module: query.module,
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    }),
    getExceptionAlerts(fyObjectId, effectiveNodeIds),
  ]);

  const alerts = [...buildBudgetAlerts(budgetKpis, pendingApprovals, nodeSummaries), ...exceptionAlerts];

  return {
    scope: { organizationNodeId: query.organizationNodeId ?? null },
    financialYear: { _id: String(fy._id), financialYear: fy.financialYear },
    budgetKpis,
    approvalKpis,
    pendingApprovals,
    nodeSummaries,
    expenditureOverview,
    payrollOverview,
    recentTransactions,
    alerts,
  };
}
