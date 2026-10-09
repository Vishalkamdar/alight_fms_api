import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { ExpenditureModel } from "../../models/fms/Expenditure";
import { PayrollBatchModel, type PayrollDeductionSnapshot } from "../../models/fms/PayrollBatch";
import { BudgetAllocationModel } from "../../models/fms/BudgetAllocation";
import { BudgetSetupModel } from "../../models/fms/BudgetSetup";
import { FundTransferModel } from "../../models/fms/FundTransfer";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { BeneficiaryModel, type BeneficiaryType } from "../../models/fms/Beneficiary";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { UserModel } from "../../models/User";
import {
  nodeFilter,
  headFilter,
  sumField,
  resolveRootNodeIds,
  resolveHeadRootIds,
  resolveNodeRootMap,
  resolveEffectiveNodeIds,
  resolveEffectiveHeadIds,
  getAllowedNodeIdsForReporting,
  resolveFinancialYear,
  resolveNames,
  type ReportActorContext,
} from "./report-aggregation.service";
import { computeNodeFinancialSummaries, getBudgetKpis, getExpenditureOverview, getPayrollOverview } from "./dashboard.service";
import { listBudgetSetups } from "./budget-setup.service";
import { listBudgetAllocations } from "./budget-allocation.service";
import type { ReportFilters, ApprovalStatusFilters } from "../../schemas/fms/reports.schema";

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

function paginateInMemory<T>(rows: T[], page: number, limit: number): ListResult<T> {
  const total = rows.length;
  const start = (page - 1) * limit;
  return {
    items: rows.slice(start, start + limit),
    meta: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  };
}

async function scope(actor: ReportActorContext, filters: { organizationNodeId?: string; financialYearId?: string }) {
  const fy = await resolveFinancialYear(filters.financialYearId);
  const effectiveNodeIds = await resolveEffectiveNodeIds(actor, filters.organizationNodeId);
  return { fy, fyObjectId: fy._id, effectiveNodeIds };
}

// ---------------------------------------------------------------------------
// §3 — Budget Summary Report (+ drill-down)
// ---------------------------------------------------------------------------

export interface BudgetSummaryRow {
  organizationNodeId: string;
  nodeName: string;
  totalBudget: number;
  allocated: number;
  available: number;
  onHold: number;
  used: number;
  remaining: number;
}

export async function getBudgetSummaryReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<BudgetSummaryRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const nodeRows = await computeNodeFinancialSummaries(fyObjectId, effectiveNodeIds);

  const rootMap = await resolveNodeRootMap(nodeRows.map((r) => r.organizationNodeId));
  const rootIds = [...new Set(rootMap.values())];
  const budgetSetupRows =
    rootIds.length > 0
      ? await BudgetSetupModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
          { $match: { financialYearId: fyObjectId, organizationNodeId: { $in: rootIds.map((id) => new Types.ObjectId(id)) } } },
          { $group: { _id: "$organizationNodeId", amount: { $sum: "$originalAmount" } } },
        ])
      : [];
  const budgetByRoot = new Map(budgetSetupRows.map((r) => [String(r._id), r.amount]));

  const rows: BudgetSummaryRow[] = nodeRows.map((row) => {
    const rootId = rootMap.get(row.organizationNodeId) ?? row.organizationNodeId;
    const totalBudget = budgetByRoot.get(rootId) ?? 0;
    const used = row.expenditure;
    return {
      organizationNodeId: row.organizationNodeId,
      nodeName: row.nodeName,
      totalBudget,
      allocated: row.allocated,
      available: Math.max(row.available, 0),
      onHold: row.onHold,
      used,
      remaining: Math.max(row.available - used, 0),
    };
  });

  return paginateInMemory(rows, filters.page, filters.limit);
}

export interface BudgetSummaryDrilldown {
  budgetSetups: Awaited<ReturnType<typeof listBudgetSetups>>["items"];
  budgetAllocations: Awaited<ReturnType<typeof listBudgetAllocations>>["items"];
}

export async function getBudgetSummaryDrilldown(
  organizationNodeId: string,
  filters: ReportFilters,
  actor: ReportActorContext
): Promise<BudgetSummaryDrilldown> {
  const effectiveNodeIds = await resolveEffectiveNodeIds(actor, organizationNodeId);
  const rootMap = await resolveNodeRootMap([organizationNodeId]);
  const rootId = rootMap.get(organizationNodeId) ?? organizationNodeId;

  const [budgetSetups, budgetAllocations] = await Promise.all([
    listBudgetSetups(
      { organizationNodeId: rootId, financialYearId: filters.financialYearId, page: 1, limit: 100, sortBy: "createdAt", sortOrder: "desc" } as never,
      effectiveNodeIds === null ? null : [rootId]
    ),
    listBudgetAllocations(
      { organizationNodeId, financialYearId: filters.financialYearId, page: 1, limit: 100, sortBy: "createdAt", sortOrder: "desc" } as never,
      effectiveNodeIds
    ),
  ]);

  return { budgetSetups: budgetSetups.items, budgetAllocations: budgetAllocations.items };
}

// ---------------------------------------------------------------------------
// §4 — Budget Allocation Report (thin filtered wrapper)
// ---------------------------------------------------------------------------

export async function getBudgetAllocationReport(filters: ReportFilters, actor: ReportActorContext) {
  const effectiveNodeIds = await resolveEffectiveNodeIds(actor, filters.organizationNodeId);
  const effectiveHeadIds = await resolveEffectiveHeadIds(actor, filters.headId);
  return listBudgetAllocations(
    {
      financialYearId: filters.financialYearId,
      organizationNodeId: filters.organizationNodeId,
      organizationRootNodeId: filters.organizationRootNodeId,
      schemeHeadRootNodeId: filters.schemeHeadRootNodeId,
      headId: filters.headId,
      approvalStatus: filters.status as never,
      maker: filters.userId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      page: filters.page,
      limit: filters.limit,
      sortBy: filters.sortBy ?? "createdAt",
      sortOrder: filters.sortOrder,
    } as never,
    effectiveNodeIds,
    effectiveHeadIds
  );
}

// ---------------------------------------------------------------------------
// §5 — Budget Availability Report
// ---------------------------------------------------------------------------

export interface BudgetAvailabilityReport {
  totalBudget: number;
  allocated: number;
  available: number;
  onHold: number;
  used: number;
  returned: number;
  pulled: number;
}

export async function getBudgetAvailabilityReport(filters: ReportFilters, actor: ReportActorContext): Promise<BudgetAvailabilityReport> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const kpis = await getBudgetKpis(fyObjectId, effectiveNodeIds);

  const rootNodeIds = effectiveNodeIds === null ? null : await resolveRootNodeIds(effectiveNodeIds);
  const [pulled, returned] = await Promise.all([
    sumField(FundTransferModel, "amount", {
      financialYearId: fyObjectId,
      transactionType: "PULL_FROM_CHILD",
      approvalStatus: "APPROVED",
      ...nodeFilter(rootNodeIds, "organizationRootNodeId"),
    }),
    sumField(FundTransferModel, "amount", {
      financialYearId: fyObjectId,
      transactionType: "RETURN_TO_PARENT",
      approvalStatus: "APPROVED",
      ...nodeFilter(rootNodeIds, "organizationRootNodeId"),
    }),
  ]);

  return {
    totalBudget: kpis.totalBudget,
    allocated: kpis.allocated,
    // Negative financial balances must never be displayed (explicit spec requirement).
    available: Math.max(kpis.available, 0),
    onHold: kpis.onHold,
    used: kpis.totalExpenditure + kpis.totalPayroll,
    returned,
    pulled,
  };
}

// ---------------------------------------------------------------------------
// §6 — Expenditure Report
// ---------------------------------------------------------------------------

export interface ExpenditureReportRow {
  _id: string;
  billVoucherNumber: string;
  billVoucherDate: Date;
  organizationNode: string;
  schemeHeadRoot: string;
  head: string;
  beneficiary: string;
  beneficiaryType: BeneficiaryType;
  grossAmount: number;
  tax: number;
  deduction: number;
  netPayableAmount: number;
  approvalStatus: string;
  paymentStatus: string;
  maker: string;
  verifier: string;
  checker: string;
  paymentDate: Date | null;
}

function buildCommonMatch(
  filters: ReportFilters,
  fyObjectId: Types.ObjectId,
  effectiveNodeIds: string[] | null,
  dateField: string,
  // `null` (no Head restriction/filter) is a no-op, same contract as
  // nodeFilter — already validated against the caller's allowed Head set by
  // resolveEffectiveHeadIds before reaching here. Field name differs by
  // model: Expenditure has a real per-record `headId`; PayrollBatch has
  // none, only a root-pool `schemeHeadRootNodeId` — the caller resolves to
  // the matching field name via `headIdField`.
  effectiveHeadIds: string[] | null = null,
  headIdField: "headId" | "schemeHeadRootNodeId" = "headId"
) {
  const match: Record<string, unknown> = {
    financialYearId: fyObjectId,
    ...nodeFilter(effectiveNodeIds),
    ...headFilter(effectiveHeadIds, headIdField),
  };
  if (filters.schemeHeadRootNodeId) match.schemeHeadRootNodeId = new Types.ObjectId(filters.schemeHeadRootNodeId);
  if (filters.beneficiaryId) match.beneficiaryId = new Types.ObjectId(filters.beneficiaryId);
  if (filters.beneficiaryType) match.beneficiaryType = filters.beneficiaryType;
  if (filters.status) match.approvalStatus = filters.status;
  if (filters.userId) match.makerId = new Types.ObjectId(filters.userId);
  if (filters.dateFrom || filters.dateTo) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range.$gte = filters.dateFrom;
    if (filters.dateTo) range.$lte = filters.dateTo;
    match[dateField] = range;
  }
  return match;
}

export async function getExpenditureReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<ExpenditureReportRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const effectiveHeadIds = await resolveEffectiveHeadIds(actor, filters.headId);
  const match = buildCommonMatch(filters, fyObjectId, effectiveNodeIds, "billVoucherDate", effectiveHeadIds, "headId");

  const [docs, total] = await Promise.all([
    ExpenditureModel.find(match)
      .sort({ [filters.sortBy ?? "billVoucherDate"]: filters.sortOrder === "asc" ? 1 : -1 })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .lean(),
    ExpenditureModel.countDocuments(match),
  ]);

  const [nodeNames, schemeNames, userNames] = await Promise.all([
    resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
    resolveNames(SchemeHeadNodeModel, [...docs.map((d) => d.schemeHeadRootNodeId), ...docs.map((d) => d.headId)], "name"),
    resolveNames(
      UserModel,
      docs.flatMap((d) => [d.makerId, d.verifierId, d.checkerId]),
      "fullname"
    ),
  ]);

  const items: ExpenditureReportRow[] = docs.map((d) => ({
    _id: String(d._id),
    billVoucherNumber: d.billVoucherNumber,
    billVoucherDate: d.billVoucherDate,
    organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
    schemeHeadRoot: schemeNames.get(String(d.schemeHeadRootNodeId)) ?? "",
    head: schemeNames.get(String(d.headId)) ?? "",
    beneficiary: d.beneficiarySnapshot.name,
    beneficiaryType: d.beneficiaryType,
    grossAmount: d.grossAmount,
    tax: d.cgstAmount + d.sgstAmount + d.igstAmount,
    deduction: d.totalDeduction,
    netPayableAmount: d.netPayableAmount,
    approvalStatus: d.approvalStatus,
    paymentStatus: d.paymentStatus,
    maker: d.makerId ? userNames.get(String(d.makerId)) ?? "" : "",
    verifier: d.verifierId ? userNames.get(String(d.verifierId)) ?? "" : "",
    checker: d.checkerId ? userNames.get(String(d.checkerId)) ?? "" : "",
    paymentDate: d.paymentCompletedAt,
  }));

  return { items, meta: { page: filters.page, limit: filters.limit, total, totalPages: Math.max(Math.ceil(total / filters.limit), 1) } };
}

// ---------------------------------------------------------------------------
// §7/§8 — Payroll Report (+ Employee Payroll Detail drill-down)
// ---------------------------------------------------------------------------

export interface PayrollReportRow {
  _id: string;
  payrollNumber: string;
  month: string;
  organizationNode: string;
  schemeHeadRoot: string;
  employeeCount: number;
  grossSalary: number;
  totalDeduction: number;
  netPayroll: number;
  approvalStatus: string;
  paymentStatus: string;
  maker: string;
  verifier: string;
  checker: string;
}

export async function getPayrollReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<PayrollReportRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const effectiveHeadIds = await resolveEffectiveHeadIds(actor, filters.headId);
  // PayrollBatch has no per-record headId, only a root-pool
  // schemeHeadRootNodeId — resolve each allowed/requested head up to its
  // own scheme root first (same approach as the Dashboard's Payroll Overview).
  const payrollHeadRootIds = effectiveHeadIds === null ? null : await resolveHeadRootIds(effectiveHeadIds);
  const match = buildCommonMatch(filters, fyObjectId, effectiveNodeIds, "createdAt", payrollHeadRootIds, "schemeHeadRootNodeId");

  const [docs, total] = await Promise.all([
    PayrollBatchModel.find(match)
      .sort({ [filters.sortBy ?? "createdAt"]: filters.sortOrder === "asc" ? 1 : -1 })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .lean(),
    PayrollBatchModel.countDocuments(match),
  ]);

  const [nodeNames, schemeNames, userNames] = await Promise.all([
    resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name"),
    resolveNames(SchemeHeadNodeModel, docs.map((d) => d.schemeHeadRootNodeId), "name"),
    resolveNames(
      UserModel,
      docs.flatMap((d) => [d.makerId, d.verifierId, d.checkerId]),
      "fullname"
    ),
  ]);

  const items: PayrollReportRow[] = docs.map((d) => ({
    _id: String(d._id),
    payrollNumber: d.payrollNumber,
    month: d.month,
    organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
    schemeHeadRoot: schemeNames.get(String(d.schemeHeadRootNodeId)) ?? "",
    employeeCount: d.employees.length,
    grossSalary: d.totalGrossSalary,
    totalDeduction: d.totalDeduction,
    netPayroll: d.totalNetSalary,
    approvalStatus: d.approvalStatus,
    paymentStatus: d.paymentStatus,
    maker: d.makerId ? userNames.get(String(d.makerId)) ?? "" : "",
    verifier: d.verifierId ? userNames.get(String(d.verifierId)) ?? "" : "",
    checker: d.checkerId ? userNames.get(String(d.checkerId)) ?? "" : "",
  }));

  return { items, meta: { page: filters.page, limit: filters.limit, total, totalPages: Math.max(Math.ceil(total / filters.limit), 1) } };
}

export interface EmployeePayrollDetailRow {
  employee: string;
  employeeId: string | null;
  grossSalary: number;
  deductions: Record<string, number | null>;
  totalDeduction: number;
  netSalary: number;
  paymentStatus: string;
}

export interface EmployeePayrollDetail {
  payrollNumber: string;
  deductionColumns: string[];
  rows: EmployeePayrollDetailRow[];
}

/**
 * Pivots each employee's `deductions[]` (already carrying `deductionName`
 * per snapshot) into dynamic columns — one per distinct deduction name
 * present anywhere in the batch, `null` (blank) where a given employee
 * doesn't have that deduction, never hardcoded. First helper of its kind
 * in this codebase — nothing existing to reuse.
 */
export async function getEmployeePayrollDetail(payrollBatchId: string, actor: ReportActorContext): Promise<EmployeePayrollDetail> {
  const batch = await PayrollBatchModel.findById(payrollBatchId);
  if (!batch) throw new AppError(404, "Payroll batch not found.");

  // Deliberately not resolveEffectiveNodeIds(actor, batch.organizationNodeId)
  // — that throws its own 403 the instant the id is out of scope, which
  // would leak "this batch exists but you can't see it" via status code.
  // Fetch the caller's allowed set directly and fold the mismatch into the
  // same generic 404 an unknown id would get, same as every other
  // existence-oracle-avoidance in this file.
  const allowedNodeIds = await getAllowedNodeIdsForReporting(actor);
  if (allowedNodeIds !== null && !allowedNodeIds.includes(String(batch.organizationNodeId))) {
    throw new AppError(404, "Payroll batch not found.");
  }

  const deductionColumns = [...new Set(batch.employees.flatMap((e) => e.deductions.map((d: PayrollDeductionSnapshot) => d.deductionName)))];

  const rows: EmployeePayrollDetailRow[] = batch.employees.map((employee) => {
    const deductions: Record<string, number | null> = {};
    for (const column of deductionColumns) {
      const snapshot = employee.deductions.find((d: PayrollDeductionSnapshot) => d.deductionName === column);
      deductions[column] = snapshot ? snapshot.calculatedAmount : null;
    }
    return {
      employee: employee.beneficiarySnapshot.name,
      employeeId: employee.beneficiarySnapshot.employeeId,
      grossSalary: employee.salaryAmount,
      deductions,
      totalDeduction: employee.totalDeduction,
      netSalary: employee.netSalary,
      paymentStatus: employee.paymentStatus,
    };
  });

  return { payrollNumber: batch.payrollNumber, deductionColumns, rows };
}

// ---------------------------------------------------------------------------
// §9 — Approval Status Report (cross-module union)
// ---------------------------------------------------------------------------

export interface ApprovalStatusRow {
  module: string;
  transactionNumber: string;
  organizationNode: string;
  amount: number;
  maker: string;
  verifier: string;
  checker: string;
  currentStage: string;
  status: string;
  createdDate: Date;
  verificationDate: Date | null;
  approvalDate: Date | null;
}

const STAGE_LABELS: Record<string, string> = {
  PENDING_VERIFICATION: "Pending Verification",
  PENDING_CHECKER_APPROVAL: "Pending Checker Approval",
  APPROVED: "Approved",
  REJECTED_BY_VERIFIER: "Rejected by Verifier",
  REJECTED_BY_CHECKER: "Rejected by Checker",
};

async function approvalRowsForModule(
  moduleLabel: string,
  Model: mongoose.Model<any>,
  match: Record<string, unknown>,
  amountField: string,
  numberField: string | null
): Promise<ApprovalStatusRow[]> {
  const docs = await Model.find(match).select(`${amountField} ${numberField ?? ""} organizationNodeId makerId verifierId checkerId approvalStatus verifiedAt approvedAt createdAt`).lean();
  const [nodeNames, userNames] = await Promise.all([
    resolveNames(OrganizationNodeModel, docs.map((d: any) => d.organizationNodeId), "name"),
    resolveNames(
      UserModel,
      docs.flatMap((d: any) => [d.makerId, d.verifierId, d.checkerId]),
      "fullname"
    ),
  ]);
  return docs.map((d: any) => ({
    module: moduleLabel,
    transactionNumber: numberField ? d[numberField] : String(d._id),
    organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
    amount: d[amountField],
    maker: d.makerId ? userNames.get(String(d.makerId)) ?? "" : "",
    verifier: d.verifierId ? userNames.get(String(d.verifierId)) ?? "" : "",
    checker: d.checkerId ? userNames.get(String(d.checkerId)) ?? "" : "",
    currentStage: STAGE_LABELS[d.approvalStatus] ?? d.approvalStatus,
    status: d.approvalStatus,
    createdDate: d.createdAt,
    verificationDate: d.verifiedAt ?? null,
    approvalDate: d.approvedAt ?? null,
  }));
}

export async function getApprovalStatusReport(filters: ApprovalStatusFilters, actor: ReportActorContext): Promise<ListResult<ApprovalStatusRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const baseMatch: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds) };
  if (filters.approvalStatus) baseMatch.approvalStatus = filters.approvalStatus;
  if (filters.userId) baseMatch.makerId = new Types.ObjectId(filters.userId);
  if (filters.dateFrom || filters.dateTo) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range.$gte = filters.dateFrom;
    if (filters.dateTo) range.$lte = filters.dateTo;
    baseMatch.createdAt = range;
  }

  // BudgetSetup's own `organizationNodeId` means the scope ROOT, not a
  // specific target node — the later spread key wins, overriding baseMatch's
  // target-node filter with the resolved root-node filter for this one case.
  const rootNodeIds = effectiveNodeIds === null ? null : await resolveRootNodeIds(effectiveNodeIds);
  const budgetSetupMatch = { ...baseMatch, ...nodeFilter(rootNodeIds, "organizationNodeId") };

  const wants = (moduleKey: string) => !filters.module || filters.module === moduleKey;
  const results: ApprovalStatusRow[] = [];
  if (wants("EXPENDITURE")) results.push(...(await approvalRowsForModule("Expenditure", ExpenditureModel, baseMatch, "netPayableAmount", "billVoucherNumber")));
  if (wants("PAYROLL")) results.push(...(await approvalRowsForModule("Payroll", PayrollBatchModel, baseMatch, "totalNetSalary", "payrollNumber")));
  if (wants("BUDGET_ALLOCATION")) results.push(...(await approvalRowsForModule("Budget Allocation", BudgetAllocationModel, baseMatch, "amount", null)));
  if (wants("BUDGET_SETUP")) results.push(...(await approvalRowsForModule("Budget Setup", BudgetSetupModel, budgetSetupMatch, "originalAmount", null)));

  results.sort((a, b) => b.createdDate.getTime() - a.createdDate.getTime());
  return paginateInMemory(results, filters.page, filters.limit);
}

// ---------------------------------------------------------------------------
// §10 — Payment Status Report (Expenditure + Payroll only — the only two
// modules with a real payment-to-beneficiary lifecycle)
// ---------------------------------------------------------------------------

export interface PaymentStatusRow {
  transactionNumber: string;
  module: string;
  beneficiary: string;
  beneficiaryType: string;
  organizationNode: string;
  amount: number;
  paymentStatus: string;
  paymentReference: string | null;
  paymentDate: Date | null;
  failureReason: string | null;
}

export async function getPaymentStatusReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<PaymentStatusRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const baseMatch: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds) };
  if (filters.status) baseMatch.paymentStatus = filters.status;
  if (filters.beneficiaryId) baseMatch.beneficiaryId = new Types.ObjectId(filters.beneficiaryId);

  const wants = (moduleKey: string) => !filters.module || filters.module === moduleKey;
  const results: PaymentStatusRow[] = [];

  if (wants("EXPENDITURE")) {
    const docs = await ExpenditureModel.find(baseMatch)
      .select("billVoucherNumber beneficiarySnapshot beneficiaryType organizationNodeId netPayableAmount paymentStatus paymentReference paymentCompletedAt paymentFailureReason")
      .lean();
    const nodeNames = await resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name");
    results.push(
      ...docs.map((d) => ({
        transactionNumber: d.billVoucherNumber,
        module: "Expenditure",
        beneficiary: d.beneficiarySnapshot.name,
        beneficiaryType: d.beneficiaryType,
        organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
        amount: d.netPayableAmount,
        paymentStatus: d.paymentStatus,
        paymentReference: d.paymentReference,
        paymentDate: d.paymentCompletedAt,
        failureReason: d.paymentFailureReason,
      }))
    );
  }

  if (wants("PAYROLL")) {
    const payrollMatch = { ...baseMatch };
    delete payrollMatch.paymentStatus;
    delete payrollMatch.beneficiaryId;
    const docs = await PayrollBatchModel.find(payrollMatch).select("payrollNumber organizationNodeId employees").lean();
    const nodeNames = await resolveNames(OrganizationNodeModel, docs.map((d) => d.organizationNodeId), "name");
    for (const d of docs) {
      for (const employee of d.employees) {
        if (filters.status && employee.paymentStatus !== filters.status) continue;
        if (filters.beneficiaryId && String(employee.beneficiaryId) !== filters.beneficiaryId) continue;
        results.push({
          transactionNumber: d.payrollNumber,
          module: "Payroll",
          beneficiary: employee.beneficiarySnapshot.name,
          beneficiaryType: "EMPLOYEE",
          organizationNode: nodeNames.get(String(d.organizationNodeId)) ?? "",
          amount: employee.netSalary,
          paymentStatus: employee.paymentStatus,
          paymentReference: employee.paymentReference,
          paymentDate: employee.paymentCompletedAt,
          failureReason: employee.paymentFailureReason,
        });
      }
    }
  }

  return paginateInMemory(results, filters.page, filters.limit);
}

// ---------------------------------------------------------------------------
// §11 — Organization Node Financial Report
// ---------------------------------------------------------------------------

export interface OrganizationNodeFinancialRow {
  organizationNodeId: string;
  nodeName: string;
  budget: number;
  allocated: number;
  available: number;
  onHold: number;
  expenditure: number;
  payroll: number;
}

export async function getOrganizationNodeFinancialReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<OrganizationNodeFinancialRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const nodeRows = await computeNodeFinancialSummaries(fyObjectId, effectiveNodeIds);

  const payrollRows = await PayrollBatchModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
    { $match: { financialYearId: fyObjectId, ...nodeFilter(effectiveNodeIds) } },
    { $group: { _id: "$organizationNodeId", amount: { $sum: "$totalNetSalary" } } },
  ]);
  const payrollMap = new Map(payrollRows.map((r) => [String(r._id), r.amount]));

  const rows: OrganizationNodeFinancialRow[] = nodeRows.map((row) => ({
    organizationNodeId: row.organizationNodeId,
    nodeName: row.nodeName,
    budget: row.budget,
    allocated: row.allocated,
    available: Math.max(row.available, 0),
    onHold: row.onHold,
    expenditure: row.expenditure,
    payroll: payrollMap.get(row.organizationNodeId) ?? 0,
  }));

  return paginateInMemory(rows, filters.page, filters.limit);
}

// ---------------------------------------------------------------------------
// §12 — Beneficiary Payment Report ($unionWith across Expenditure + Payroll)
// ---------------------------------------------------------------------------

export interface BeneficiaryPaymentRow {
  beneficiaryId: string;
  beneficiary: string;
  beneficiaryType: string;
  organizationNode: string;
  transactionCount: number;
  grossAmount: number;
  deduction: number;
  netAmount: number;
  paidAmount: number;
  pendingAmount: number;
}

export async function getBeneficiaryPaymentReport(filters: ReportFilters, actor: ReportActorContext): Promise<ListResult<BeneficiaryPaymentRow>> {
  const { fyObjectId, effectiveNodeIds } = await scope(actor, filters);
  const nodeMatch = nodeFilter(effectiveNodeIds);

  const expenditureMatch: Record<string, unknown> = { financialYearId: fyObjectId, ...nodeMatch };
  if (filters.beneficiaryType) expenditureMatch.beneficiaryType = filters.beneficiaryType;
  if (filters.beneficiaryId) expenditureMatch.beneficiaryId = new Types.ObjectId(filters.beneficiaryId);

  const pipeline = [
    { $match: expenditureMatch },
    {
      $project: {
        beneficiaryId: 1,
        beneficiaryType: 1,
        organizationNodeId: 1,
        grossAmount: "$netPayableAmount",
        deduction: "$totalDeduction",
        paid: { $cond: [{ $eq: ["$paymentStatus", "PAYMENT_SUCCESS"] }, "$netPayableAmount", 0] },
        pending: { $cond: [{ $ne: ["$paymentStatus", "PAYMENT_SUCCESS"] }, "$netPayableAmount", 0] },
      },
    },
    {
      $unionWith: {
        coll: "payrollbatches",
        pipeline: [
          { $match: { financialYearId: fyObjectId, ...nodeMatch } },
          { $unwind: "$employees" },
          ...(filters.beneficiaryType && filters.beneficiaryType !== "EMPLOYEE" ? [{ $match: { _id: null } }] : []),
          ...(filters.beneficiaryId ? [{ $match: { "employees.beneficiaryId": new Types.ObjectId(filters.beneficiaryId) } }] : []),
          {
            $project: {
              beneficiaryId: "$employees.beneficiaryId",
              beneficiaryType: { $literal: "EMPLOYEE" },
              organizationNodeId: 1,
              grossAmount: "$employees.netSalary",
              deduction: "$employees.totalDeduction",
              paid: { $cond: [{ $eq: ["$employees.paymentStatus", "PAYMENT_SUCCESS"] }, "$employees.netSalary", 0] },
              pending: { $cond: [{ $ne: ["$employees.paymentStatus", "PAYMENT_SUCCESS"] }, "$employees.netSalary", 0] },
            },
          },
        ],
      },
    },
    {
      $group: {
        _id: { beneficiaryId: "$beneficiaryId", beneficiaryType: "$beneficiaryType" },
        organizationNodeId: { $first: "$organizationNodeId" },
        transactionCount: { $sum: 1 },
        grossAmount: { $sum: "$grossAmount" },
        deduction: { $sum: "$deduction" },
        paidAmount: { $sum: "$paid" },
        pendingAmount: { $sum: "$pending" },
      },
    },
    { $sort: { grossAmount: -1 as const } },
    {
      $facet: {
        items: [{ $skip: (filters.page - 1) * filters.limit }, { $limit: filters.limit }],
        totalCount: [{ $count: "count" }],
      },
    },
  ];

  const [result] = await ExpenditureModel.aggregate(pipeline);
  const total: number = result.totalCount[0]?.count ?? 0;
  const rawItems: Array<{
    _id: { beneficiaryId: Types.ObjectId; beneficiaryType: string };
    organizationNodeId: Types.ObjectId;
    transactionCount: number;
    grossAmount: number;
    deduction: number;
    paidAmount: number;
    pendingAmount: number;
  }> = result.items;

  const [beneficiaryNames, nodeNames] = await Promise.all([
    resolveNames(BeneficiaryModel, rawItems.map((r) => r._id.beneficiaryId), "name"),
    resolveNames(OrganizationNodeModel, rawItems.map((r) => r.organizationNodeId), "name"),
  ]);

  const items: BeneficiaryPaymentRow[] = rawItems.map((r) => ({
    beneficiaryId: String(r._id.beneficiaryId),
    beneficiary: beneficiaryNames.get(String(r._id.beneficiaryId)) ?? "",
    beneficiaryType: r._id.beneficiaryType,
    organizationNode: nodeNames.get(String(r.organizationNodeId)) ?? "",
    transactionCount: r.transactionCount,
    grossAmount: r.grossAmount,
    deduction: r.deduction,
    netAmount: r.grossAmount - r.deduction,
    paidAmount: r.paidAmount,
    pendingAmount: r.pendingAmount,
  }));

  return { items, meta: { page: filters.page, limit: filters.limit, total, totalPages: Math.max(Math.ceil(total / filters.limit), 1) } };
}

// ---------------------------------------------------------------------------
// §13/§14 — Financial Year Summary (+ Monthly Financial Trend)
// ---------------------------------------------------------------------------

export interface FinancialYearSummaryReport {
  financialYear: string;
  budgetKpis: Awaited<ReturnType<typeof getBudgetKpis>>;
  totalPayments: number;
  monthlyTrend: Array<{ month: string; expenditure: number; payroll: number }>;
}

export async function getFinancialYearSummaryReport(
  filters: { financialYearId?: string; organizationNodeId?: string },
  actor: ReportActorContext
): Promise<FinancialYearSummaryReport> {
  const { fy, fyObjectId, effectiveNodeIds } = await scope(actor, filters);

  const [budgetKpis, expenditureOverview, payrollOverview] = await Promise.all([
    getBudgetKpis(fyObjectId, effectiveNodeIds),
    getExpenditureOverview(fy, effectiveNodeIds),
    getPayrollOverview(fy, effectiveNodeIds),
  ]);

  const monthlyTrend = expenditureOverview.trend.map((point, i) => ({
    month: point.month,
    expenditure: point.amount,
    payroll: payrollOverview.trend[i]?.amount ?? 0,
  }));

  return {
    financialYear: fy.financialYear,
    budgetKpis,
    totalPayments: expenditureOverview.paid + payrollOverview.paid,
    monthlyTrend,
  };
}
