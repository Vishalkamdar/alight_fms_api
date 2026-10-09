import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import {
  FinancialYearModel,
  type FinancialYearDocument,
  type FinancialYearStatus,
} from "../../models/fms/FinancialYear";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { ExpenditureModel } from "../../models/fms/Expenditure";
import { PayrollBatchModel } from "../../models/fms/PayrollBatch";
import { BudgetAllocationModel } from "../../models/fms/BudgetAllocation";
import { BudgetSetupModel } from "../../models/fms/BudgetSetup";
import { FundTransferModel } from "../../models/fms/FundTransfer";
import type {
  CreateFinancialYearInput,
  FinancialYearListQuery,
  UpdateFinancialYearInput,
} from "../../schemas/fms/financial-year.schema";

// Small, self-contained aggregation helpers — deliberately NOT imported from
// report-aggregation.service.ts, which itself imports getCurrentFinancialYear
// from this file; importing back from there would create a circular module
// dependency. These two are a handful of lines each, cheap to keep local.
const PENDING_STATUSES = ["PENDING_VERIFICATION", "PENDING_CHECKER_APPROVAL"] as const;

async function sumField(Model: mongoose.Model<any>, field: string, match: Record<string, unknown>): Promise<number> {
  const rows = await Model.aggregate<{ _id: null; sum: number }>([{ $match: match }, { $group: { _id: null, sum: { $sum: `$${field}` } } }]);
  return rows[0]?.sum ?? 0;
}

interface ActorContext {
  actorId: Types.ObjectId | null;
  ipAddress: string | null;
  userAgent?: string | null;
}

export interface FinancialYearDto {
  _id: string;
  financialYear: string;
  startDate: Date;
  endDate: Date;
  status: FinancialYearStatus;
  isCurrent: boolean;
  isClosed: boolean;
  entryEnabled: boolean;
  entryEnabledAt: Date | null;
  entryEnabledBy: string | null;
  viewOnly: boolean;
  viewOnlyEnabledAt: Date | null;
  viewOnlyEnabledBy: string | null;
  /** "ACTIVE_ENTRY" | "VIEW_ONLY" | "CLOSED" | "RESTRICTED" — derived so every surface shows the same label without re-deriving it. */
  accessState: "ACTIVE_ENTRY" | "VIEW_ONLY" | "CLOSED" | "RESTRICTED";
  closedAt: Date | null;
  closedBy: string | null;
  reopenedAt: Date | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Active Entry / View Only / Closed — the one derived label every surface shows instead of reasoning about three raw flags itself. */
function deriveAccessState(doc: Pick<FinancialYearDocument, "isClosed" | "viewOnly" | "entryEnabled">): "ACTIVE_ENTRY" | "VIEW_ONLY" | "CLOSED" | "RESTRICTED" {
  if (doc.isClosed) return "CLOSED";
  if (doc.viewOnly) return "VIEW_ONLY";
  if (doc.entryEnabled) return "ACTIVE_ENTRY";
  return "RESTRICTED";
}

function serialize(doc: FinancialYearDocument): FinancialYearDto {
  return {
    _id: String(doc._id),
    financialYear: doc.financialYear,
    startDate: doc.startDate,
    endDate: doc.endDate,
    status: doc.status,
    isCurrent: doc.isCurrent,
    isClosed: doc.isClosed,
    entryEnabled: doc.entryEnabled,
    entryEnabledAt: doc.entryEnabledAt,
    entryEnabledBy: doc.entryEnabledBy ? String(doc.entryEnabledBy) : null,
    viewOnly: doc.viewOnly,
    viewOnlyEnabledAt: doc.viewOnlyEnabledAt,
    viewOnlyEnabledBy: doc.viewOnlyEnabledBy ? String(doc.viewOnlyEnabledBy) : null,
    accessState: deriveAccessState(doc),
    closedAt: doc.closedAt,
    closedBy: doc.closedBy ? String(doc.closedBy) : null,
    reopenedAt: doc.reopenedAt,
    reopenedBy: doc.reopenedBy ? String(doc.reopenedBy) : null,
    reopenReason: doc.reopenReason,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Pure date math — the Indian Financial Year, 1 April -> 31 March.
// ---------------------------------------------------------------------------

export interface FinancialYearRange {
  label: string;
  startDate: Date;
  endDate: Date;
}

/** startYear=2026 -> "2026-27", 01-Apr-2026 -> 31-Mar-2027. */
export function computeFinancialYearRange(startYear: number): FinancialYearRange {
  const label = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  const startDate = new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0)); // April = month index 3
  const endDate = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999)); // March = month index 2
  return { label, startDate, endDate };
}

/** Which Indian FY a calendar date falls in — the backend's "no manual selection" source of truth. */
export function resolveFinancialYearRangeForDate(date: Date): FinancialYearRange {
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  return computeFinancialYearRange(startYear);
}

// ---------------------------------------------------------------------------
// Lookup / current-year detection
// ---------------------------------------------------------------------------

async function findByIdOr404(id: string): Promise<FinancialYearDocument> {
  const year = await FinancialYearModel.findById(id);
  if (!year) throw new AppError(404, "Financial Year not found.");
  return year;
}

/**
 * Makes `target` the one-and-only current Financial Year, unsetting any
 * other "current" document first so the partial unique index on isCurrent
 * never briefly sees two true values. No-ops (and logs nothing) if it's
 * already current.
 */
async function markAsCurrent(target: FinancialYearDocument, context: ActorContext): Promise<void> {
  const wasAlreadyCurrent = target.isCurrent;

  // Self-heals entryEnabled for any year that became current before this
  // flag existed (or was never explicitly set) — runs even when already
  // current, so "the current year is immediately writable" keeps holding
  // true under the new 3-state model without a separate migration step.
  // Never touches a year someone deliberately locked down (View Only or
  // Closed).
  const needsEntryBackfill = !target.viewOnly && !target.isClosed && !target.entryEnabled;
  if (wasAlreadyCurrent && !needsEntryBackfill) return;

  if (!wasAlreadyCurrent) {
    await FinancialYearModel.updateMany({ _id: { $ne: target._id }, isCurrent: true }, { $set: { isCurrent: false } });
    target.isCurrent = true;
  }
  if (needsEntryBackfill) target.entryEnabled = true;
  await target.save();

  if (wasAlreadyCurrent) return;

  await logActivity({
    user: context.actorId,
    action: "FINANCIAL_YEAR_ACTIVATED",
    module: "FMS_CONFIG",
    description: `Financial Year "${target.financialYear}" is now the current Financial Year.`,
    entityType: "FinancialYear",
    entityId: target._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

/**
 * Resolves (auto-creating if necessary) the Financial Year document for
 * `date`. This is the actual mechanism behind "the system must not simply
 * change the year text" — every call re-derives the year from the clock.
 */
export async function getOrCreateFinancialYearForDate(
  date: Date,
  context: ActorContext = { actorId: null, ipAddress: null }
): Promise<FinancialYearDocument> {
  const { label, startDate, endDate } = resolveFinancialYearRangeForDate(date);

  let year = await FinancialYearModel.findOne({ financialYear: label });
  if (!year) {
    year = await FinancialYearModel.create({
      financialYear: label,
      startDate,
      endDate,
      status: "OPEN",
      createdBy: context.actorId,
      updatedBy: context.actorId,
    });

    await logActivity({
      user: context.actorId,
      action: "FINANCIAL_YEAR_CREATED",
      module: "FMS_CONFIG",
      description: `Financial Year "${label}" auto-created for the current date.`,
      entityType: "FinancialYear",
      entityId: year._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  await markAsCurrent(year, context);
  return year;
}

/** The Financial Year "today" falls in, auto-creating/activating it on the first request of a new year. */
export async function getCurrentFinancialYear(): Promise<FinancialYearDocument> {
  return getOrCreateFinancialYearForDate(new Date());
}

/** What every future transaction module should call to default-assign a new entry's year — never frontend-supplied (spec §4). */
export async function resolveFinancialYearForNewEntry(): Promise<Types.ObjectId> {
  const current = await getCurrentFinancialYear();
  return current._id;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listFinancialYears(
  query: FinancialYearListQuery
): Promise<ListResult<FinancialYearDto>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    FinancialYearModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FinancialYearModel.countDocuments(filter),
  ]);

  return {
    items: docs.map(serialize),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

export async function getFinancialYearById(id: string): Promise<FinancialYearDto> {
  return serialize(await findByIdOr404(id));
}

export async function getCurrentFinancialYearDto(): Promise<FinancialYearDto> {
  return serialize(await getCurrentFinancialYear());
}

export async function createFinancialYear(
  input: CreateFinancialYearInput,
  context: ActorContext
): Promise<FinancialYearDto> {
  const { label, startDate, endDate } = computeFinancialYearRange(input.startYear);

  const existing = await FinancialYearModel.findOne({ financialYear: label });
  if (existing) {
    throw new AppError(409, `Financial Year "${label}" already exists.`, {
      startYear: ["This Financial Year already exists."],
    });
  }

  const created = await FinancialYearModel.create({
    financialYear: label,
    startDate,
    endDate,
    status: "OPEN",
    createdBy: context.actorId,
    updatedBy: context.actorId,
  });

  await logActivity({
    user: context.actorId,
    action: "FINANCIAL_YEAR_CREATED",
    module: "FMS_CONFIG",
    description: `Created Financial Year "${label}".`,
    entityType: "FinancialYear",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  // A manually-created year becomes "current" only if today actually falls
  // inside it — creating a future year in advance must not steal "current"
  // away from whichever year real transactions belong to today.
  const now = new Date();
  if (now >= startDate && now <= endDate) {
    await markAsCurrent(created, context);
  }

  return serialize(created);
}

export async function updateFinancialYear(
  id: string,
  input: UpdateFinancialYearInput,
  context: ActorContext
): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (year.isClosed) {
    throw new AppError(422, "A closed Financial Year is read-only. Reopen it first.");
  }

  if (input.startYear !== undefined) {
    const { label, startDate, endDate } = computeFinancialYearRange(input.startYear);
    const duplicate = await FinancialYearModel.findOne({ financialYear: label, _id: { $ne: year._id } });
    if (duplicate) {
      throw new AppError(409, `Financial Year "${label}" already exists.`, {
        startYear: ["This Financial Year already exists."],
      });
    }
    year.financialYear = label;
    year.startDate = startDate;
    year.endDate = endDate;
  }
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: "FINANCIAL_YEAR_UPDATED",
    module: "FMS_CONFIG",
    description: `Updated Financial Year "${year.financialYear}".`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const now = new Date();
  if (now >= year.startDate && now <= year.endDate) {
    await markAsCurrent(year, context);
  } else if (year.isCurrent) {
    // Editing dates moved "today" outside this year's range — clear the
    // flag and let the next read naturally re-resolve the real current year.
    year.isCurrent = false;
    await year.save();
  }

  return serialize(year);
}

/** Blocked from setting CLOSED directly — that always goes through close-books so validation can't be bypassed. */
export async function updateFinancialYearStatus(
  id: string,
  status: FinancialYearStatus,
  context: ActorContext
): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (year.isClosed) {
    throw new AppError(422, "A closed Financial Year is read-only. Use reopen instead.");
  }
  if (status === "CLOSED") {
    throw new AppError(
      400,
      "Use POST /financial-years/:id/close-books to close a Financial Year — it runs required year-end validation first."
    );
  }

  year.status = status;
  year.updatedBy = context.actorId;
  await year.save();

  return serialize(year);
}

/**
 * Enable/disable financial entries for this year — mutually exclusive with
 * `viewOnly` (spec §4: enabling one always turns the other off), and
 * rejected outright on a closed year (spec §4: "a closed Financial Year
 * cannot have either option enabled" — reopen it first).
 */
export async function setEntryEnabled(id: string, enabled: boolean, context: ActorContext): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (year.isClosed) {
    throw new AppError(422, "Cannot change entry access on a closed Financial Year. Reopen it first.");
  }

  const previousState = deriveAccessState(year);
  year.entryEnabled = enabled;
  year.entryEnabledAt = enabled ? new Date() : null;
  year.entryEnabledBy = enabled ? context.actorId : null;
  if (enabled && year.viewOnly) {
    year.viewOnly = false;
    year.viewOnlyEnabledAt = null;
    year.viewOnlyEnabledBy = null;
  }
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: enabled ? "FINANCIAL_YEAR_ENTRY_ENABLED" : "FINANCIAL_YEAR_ENTRY_DISABLED",
    module: "FMS_CONFIG",
    description: `Financial Year "${year.financialYear}" entry access changed from ${previousState} to ${deriveAccessState(year)}.`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(year);
}

/**
 * Enable/disable View Only (historical reporting, no new/modified entries)
 * — mutually exclusive with `entryEnabled`, rejected on a closed year, same
 * rules as `setEntryEnabled` mirrored the other way.
 */
export async function setViewOnly(id: string, enabled: boolean, context: ActorContext): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (year.isClosed) {
    throw new AppError(422, "Cannot change View Only access on a closed Financial Year. Reopen it first.");
  }

  const previousState = deriveAccessState(year);
  year.viewOnly = enabled;
  year.viewOnlyEnabledAt = enabled ? new Date() : null;
  year.viewOnlyEnabledBy = enabled ? context.actorId : null;
  if (enabled && year.entryEnabled) {
    year.entryEnabled = false;
    year.entryEnabledAt = null;
    year.entryEnabledBy = null;
  }
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: enabled ? "FINANCIAL_YEAR_VIEW_ONLY_ENABLED" : "FINANCIAL_YEAR_VIEW_ONLY_DISABLED",
    module: "FMS_CONFIG",
    description: `Financial Year "${year.financialYear}" entry access changed from ${previousState} to ${deriveAccessState(year)}.`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(year);
}

// ---------------------------------------------------------------------------
// Year-end closing validation — three concrete checks (spec §6/§7/§8) over
// the modules that actually exist today. An earlier pluggable
// register-a-provider abstraction lived here for a future that never
// arrived (confirmed nothing ever called it); removed in favor of the
// direct checks below, which is what every caller actually needed.
// ---------------------------------------------------------------------------

export interface DepartmentClosingRow {
  nodeId: string;
  nodeName: string;
  parentNodeName: string | null;
  headId: string | null;
  headName: string | null;
  allocatedAmount: number;
  utilizedAmount: number;
  committedAmount: number;
  pendingAmount: number;
  remainingAmount: number;
  hasPendingItems: boolean;
}

// ---------------------------------------------------------------------------
// The three named year-closing checks (spec §6/§7/§8) — computed directly
// rather than through the provider framework above, which stays in place
// unused/harmless since nothing currently needs its generic pluggability.
// ---------------------------------------------------------------------------

export interface HoldingCheck {
  hasIssue: boolean;
  amount: number;
}

export interface BankPendingCheck {
  hasIssue: boolean;
  amount: number;
  transactionCount: number;
}

/** Sum of `holdingAmount` across every module, for records still pending Verifier/Checker action in this Financial Year. */
async function computeHoldingCheck(fyObjectId: Types.ObjectId): Promise<HoldingCheck> {
  const pendingMatch = { financialYearId: fyObjectId, approvalStatus: { $in: PENDING_STATUSES } };
  const amounts = await Promise.all([
    sumField(ExpenditureModel, "holdingAmount", pendingMatch),
    sumField(PayrollBatchModel, "holdingAmount", pendingMatch),
    sumField(BudgetAllocationModel, "holdingAmount", pendingMatch),
    sumField(BudgetSetupModel, "holdingAmount", pendingMatch),
    sumField(FundTransferModel, "holdingAmount", pendingMatch),
  ]);
  const amount = amounts.reduce((sum, a) => sum + a, 0);
  return { hasIssue: amount > 0, amount };
}

/** Expenditure + Payroll amounts sent for payment but not yet confirmed successful or failed by the bank/payment provider. */
async function computeBankPendingCheck(fyObjectId: Types.ObjectId): Promise<BankPendingCheck> {
  const bankPendingStatuses = ["PAYMENT_PENDING", "PAYMENT_PROCESSING"];
  const [expenditureRows] = await ExpenditureModel.aggregate<{ _id: null; amount: number; count: number }>([
    { $match: { financialYearId: fyObjectId, paymentStatus: { $in: bankPendingStatuses } } },
    { $group: { _id: null, amount: { $sum: "$netPayableAmount" }, count: { $sum: 1 } } },
  ]);
  const [payrollRows] = await PayrollBatchModel.aggregate<{ _id: null; amount: number; count: number }>([
    { $match: { financialYearId: fyObjectId } },
    { $unwind: "$employees" },
    { $match: { "employees.paymentStatus": { $in: bankPendingStatuses } } },
    { $group: { _id: null, amount: { $sum: "$employees.netSalary" }, count: { $sum: 1 } } },
  ]);
  const amount = (expenditureRows?.amount ?? 0) + (payrollRows?.amount ?? 0);
  const transactionCount = (expenditureRows?.count ?? 0) + (payrollRows?.count ?? 0);
  return { hasIssue: amount > 0, amount, transactionCount };
}

/**
 * Every (Organization Node, Head) pair, EXCLUDING the root node itself
 * (root-level remaining is explicitly acceptable — spec §9), that still has
 * an approved Budget Allocation balance (`amount - subAllocatedAmount > 0`)
 * for this Financial Year. Purely informational — never auto-transfers
 * anything; each flagged row points at the existing Return Funds flow
 * (spec §10/§11).
 */
async function computeNodeHeadRemainingRows(fyObjectId: Types.ObjectId): Promise<DepartmentClosingRow[]> {
  const rows = await BudgetAllocationModel.aggregate<{
    _id: { organizationNodeId: Types.ObjectId; headId: Types.ObjectId | null };
    amount: number;
    subAllocated: number;
  }>([
    { $match: { financialYearId: fyObjectId, approvalStatus: "APPROVED" } },
    { $group: { _id: { organizationNodeId: "$organizationNodeId", headId: "$headId" }, amount: { $sum: "$amount" }, subAllocated: { $sum: "$subAllocatedAmount" } } },
  ]);
  if (rows.length === 0) return [];

  const nodeIds = [...new Set(rows.map((r) => String(r._id.organizationNodeId)))];
  const headIds = [...new Set(rows.map((r) => r._id.headId).filter((id): id is Types.ObjectId => Boolean(id)).map(String))];
  const [nodes, heads] = await Promise.all([
    OrganizationNodeModel.find({ _id: { $in: nodeIds } }).select("name parentNodeId").lean(),
    headIds.length > 0 ? SchemeHeadNodeModel.find({ _id: { $in: headIds } }).select("name").lean() : Promise.resolve([]),
  ]);
  const nodeById = new Map(nodes.map((n) => [String(n._id), n]));
  const headNameById = new Map(heads.map((h) => [String(h._id), h.name]));

  return rows
    .filter((r) => {
      const node = nodeById.get(String(r._id.organizationNodeId));
      return node && node.parentNodeId !== null; // root-level remaining is acceptable, never flagged.
    })
    .map((r) => {
      const node = nodeById.get(String(r._id.organizationNodeId))!;
      const remainingAmount = r.amount - r.subAllocated;
      return {
        nodeId: String(r._id.organizationNodeId),
        nodeName: node.name,
        parentNodeName: node.parentNodeId ? (nodeById.get(String(node.parentNodeId))?.name ?? null) : null,
        headId: r._id.headId ? String(r._id.headId) : null,
        headName: r._id.headId ? headNameById.get(String(r._id.headId)) ?? null : null,
        allocatedAmount: r.amount,
        utilizedAmount: 0,
        committedAmount: 0,
        pendingAmount: 0,
        remainingAmount,
        hasPendingItems: remainingAmount > 0,
      };
    });
}

export interface ClosingSummaryDto {
  financialYear: string;
  status: FinancialYearStatus;
  allocatedAmount: number;
  utilizedAmount: number;
  committedAmount: number;
  pendingAmount: number;
  remainingAmount: number;
  pendingTransactions: number;
  departmentsWithRemainingFunds: number;
  holdingCheck: HoldingCheck;
  bankPendingCheck: BankPendingCheck;
  nodeHeadRemainingRows: DepartmentClosingRow[];
  canClose: boolean;
  blockingReasons: string[];
}

export async function getClosingSummary(id: string): Promise<ClosingSummaryDto> {
  const year = await findByIdOr404(id);
  const fyObjectId = year._id;

  const [holdingCheck, bankPendingCheck, nodeHeadRemainingRows, allocatedAmount, utilizedExpenditure, utilizedPayroll] = await Promise.all([
    computeHoldingCheck(fyObjectId),
    computeBankPendingCheck(fyObjectId),
    computeNodeHeadRemainingRows(fyObjectId),
    sumField(BudgetAllocationModel, "amount", { financialYearId: fyObjectId, approvalStatus: "APPROVED" }),
    sumField(ExpenditureModel, "netPayableAmount", { financialYearId: fyObjectId, paymentStatus: "PAYMENT_SUCCESS" }),
    (async () => {
      const [agg] = await PayrollBatchModel.aggregate<{ _id: null; amount: number }>([
        { $match: { financialYearId: fyObjectId } },
        { $unwind: "$employees" },
        { $match: { "employees.paymentStatus": "PAYMENT_SUCCESS" } },
        { $group: { _id: null, amount: { $sum: "$employees.netSalary" } } },
      ]);
      return agg?.amount ?? 0;
    })(),
  ]);

  const utilizedAmount = utilizedExpenditure + utilizedPayroll;
  const blockingRows = nodeHeadRemainingRows.filter((row) => row.hasPendingItems);
  const nodeHeadRemainingTotal = blockingRows.reduce((sum, row) => sum + row.remainingAmount, 0);
  const remainingAmount = allocatedAmount - utilizedAmount - holdingCheck.amount - bankPendingCheck.amount;

  const blockingReasons: string[] = [];
  if (holdingCheck.hasIssue) blockingReasons.push(`Amount in Holding — ₹${holdingCheck.amount.toLocaleString("en-IN")} is still pending Verifier/Checker action.`);
  if (bankPendingCheck.hasIssue) {
    blockingReasons.push(
      `Bank Response Pending — ₹${bankPendingCheck.amount.toLocaleString("en-IN")} across ${bankPendingCheck.transactionCount} transaction(s) is still awaiting a bank/payment-provider response.`
    );
  }
  if (blockingRows.length > 0) {
    blockingReasons.push(`₹${nodeHeadRemainingTotal.toLocaleString("en-IN")} Remaining with Departments — return it to the Root via Fund Transfer before closing.`);
  }
  if (year.isClosed) blockingReasons.push("This Financial Year is already closed.");
  if (year.isCurrent) blockingReasons.push("Cannot close the current Financial Year — wait until the next Financial Year begins.");

  return {
    financialYear: year.financialYear,
    status: year.status,
    allocatedAmount,
    utilizedAmount,
    committedAmount: holdingCheck.amount,
    pendingAmount: bankPendingCheck.amount,
    remainingAmount,
    pendingTransactions: bankPendingCheck.transactionCount,
    departmentsWithRemainingFunds: blockingRows.length,
    holdingCheck,
    bankPendingCheck,
    nodeHeadRemainingRows,
    canClose: blockingReasons.length === 0,
    blockingReasons,
  };
}

export async function getDepartmentSummary(id: string): Promise<DepartmentClosingRow[]> {
  const year = await findByIdOr404(id);
  return computeNodeHeadRemainingRows(year._id);
}

export async function closeBooks(id: string, context: ActorContext): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);

  await logActivity({
    user: context.actorId,
    action: "CLOSE_BOOKS_STARTED",
    module: "FMS_CONFIG",
    description: `Close Books started for Financial Year "${year.financialYear}".`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  if (year.isClosed) {
    throw new AppError(422, "This Financial Year is already closed.");
  }

  const summary = await getClosingSummary(id);

  await logActivity({
    user: context.actorId,
    action: "CLOSE_BOOKS_VALIDATED",
    module: "FMS_CONFIG",
    description: `Close Books validation for "${year.financialYear}": ${summary.canClose ? "passed" : "blocked"}.`,
    status: summary.canClose ? "SUCCESS" : "FAILURE",
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  if (!summary.canClose) {
    throw new AppError(409, "Financial Year cannot be closed because pending transactions exist.", {
      blockingReasons: summary.blockingReasons,
    });
  }

  year.status = "CLOSED";
  year.isClosed = true;
  year.closedAt = new Date();
  year.closedBy = context.actorId;
  // Closing a year always resets both access flags (spec §14) — a closed
  // year can never have either enabled.
  year.entryEnabled = false;
  year.entryEnabledAt = null;
  year.entryEnabledBy = null;
  year.viewOnly = false;
  year.viewOnlyEnabledAt = null;
  year.viewOnlyEnabledBy = null;
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: "FINANCIAL_YEAR_CLOSED",
    module: "FMS_CONFIG",
    description: `Financial Year "${year.financialYear}" closed.`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(year);
}

export async function reopenFinancialYear(
  id: string,
  reason: string,
  context: ActorContext
): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (!year.isClosed) {
    throw new AppError(422, "This Financial Year is not closed.");
  }

  year.status = "OPEN";
  year.isClosed = false;
  year.reopenedAt = new Date();
  year.reopenedBy = context.actorId;
  year.reopenReason = reason;
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: "FINANCIAL_YEAR_REOPENED",
    module: "FMS_CONFIG",
    description: `Financial Year "${year.financialYear}" reopened. Reason: ${reason}`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(year);
}

// ---------------------------------------------------------------------------
// Transaction-facing validation — what every future module must call
// instead of implementing its own Financial Year logic (spec §19, §25).
// ---------------------------------------------------------------------------

/**
 * Throws unless `financialYearId` may currently receive new, modified, or
 * approval-workflow entries (spec §17/§18 — every financial module, and
 * every stage of its Maker/Verifier/Checker workflow, routes through this
 * one function; the backend, never the frontend, decides). Three-state
 * gate, in order:
 *  1. Closed — never writable, regardless of `isCurrent`.
 *  2. View Only — never writable, regardless of `isCurrent` (a Super Admin
 *     can lock down even the current year this way).
 *  3. Not the current year and `entryEnabled` was never turned on for it.
 * The current year defaults to `entryEnabled: true` (see `markAsCurrent`),
 * so it stays writable out of the box unless explicitly restricted above.
 */
export async function assertFinancialYearIsWritable(
  financialYearId: string | Types.ObjectId
): Promise<FinancialYearDocument> {
  const year = await FinancialYearModel.findById(financialYearId);
  if (!year) throw new AppError(404, "Financial Year not found.");

  if (year.status === "CLOSED" || year.isClosed) {
    throw new AppError(
      422,
      `Financial Year "${year.financialYear}" is closed and cannot accept new or modified entries.`
    );
  }
  if (year.viewOnly) {
    throw new AppError(
      422,
      `Financial Year "${year.financialYear}" is in View Only mode — no new or modified entries are allowed.`
    );
  }
  if (!year.isCurrent && !year.entryEnabled) {
    throw new AppError(
      422,
      `Entries are not allowed for Financial Year "${year.financialYear}" — it is not the current year and entry has not been enabled by a Super Admin.`
    );
  }

  return year;
}

interface PreviousYearEntryAuditParams {
  financialYearId: string | Types.ObjectId;
  actorId: Types.ObjectId;
  module: string;
  transactionType: string;
  transactionId: string;
  reason?: string;
  ipAddress: string | null;
  userAgent?: string | null;
}

/**
 * Future transaction modules call this after successfully writing an entry
 * against a non-current, previous-year-enabled Financial Year — spec §6's
 * "whenever an entry is created in a previous Financial Year, record...".
 */
export async function logPreviousYearEntryUsage(params: PreviousYearEntryAuditParams): Promise<void> {
  const year = await FinancialYearModel.findById(params.financialYearId).select(
    "financialYear entryEnabledBy"
  );

  await logActivity({
    user: params.actorId,
    action: "PREVIOUS_YEAR_ENTRY_USED",
    module: "FMS_CONFIG",
    description: `${params.transactionType} ${params.transactionId} recorded against previous Financial Year "${
      year?.financialYear ?? params.financialYearId
    }"${params.reason ? ` — ${params.reason}` : ""}.`,
    entityType: params.transactionType,
    entityId: params.transactionId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}
