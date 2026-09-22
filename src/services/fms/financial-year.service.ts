import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import {
  FinancialYearModel,
  type FinancialYearDocument,
  type FinancialYearStatus,
} from "../../models/fms/FinancialYear";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import type {
  CreateFinancialYearInput,
  FinancialYearListQuery,
  UpdateFinancialYearInput,
} from "../../schemas/fms/financial-year.schema";

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
  previousYearEntryAllowed: boolean;
  previousYearEntryEnabledAt: Date | null;
  previousYearEntryEnabledBy: string | null;
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

function serialize(doc: FinancialYearDocument): FinancialYearDto {
  return {
    _id: String(doc._id),
    financialYear: doc.financialYear,
    startDate: doc.startDate,
    endDate: doc.endDate,
    status: doc.status,
    isCurrent: doc.isCurrent,
    isClosed: doc.isClosed,
    previousYearEntryAllowed: doc.previousYearEntryAllowed,
    previousYearEntryEnabledAt: doc.previousYearEntryEnabledAt,
    previousYearEntryEnabledBy: doc.previousYearEntryEnabledBy
      ? String(doc.previousYearEntryEnabledBy)
      : null,
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
  if (target.isCurrent) return;

  await FinancialYearModel.updateMany(
    { _id: { $ne: target._id }, isCurrent: true },
    { $set: { isCurrent: false } }
  );
  target.isCurrent = true;
  await target.save();

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

export async function setPreviousYearEntryAllowed(
  id: string,
  enabled: boolean,
  context: ActorContext
): Promise<FinancialYearDto> {
  const year = await findByIdOr404(id);
  if (year.isClosed) {
    throw new AppError(422, "Cannot change previous-year entry permission on a closed Financial Year.");
  }
  if (year.isCurrent) {
    throw new AppError(
      422,
      "This is the current Financial Year — previous-year entry permission only applies to earlier years."
    );
  }

  year.previousYearEntryAllowed = enabled;
  year.previousYearEntryEnabledAt = enabled ? new Date() : null;
  year.previousYearEntryEnabledBy = enabled ? context.actorId : null;
  year.updatedBy = context.actorId;
  await year.save();

  await logActivity({
    user: context.actorId,
    action: enabled ? "PREVIOUS_YEAR_ENTRY_ENABLED" : "PREVIOUS_YEAR_ENTRY_DISABLED",
    module: "FMS_CONFIG",
    description: `${enabled ? "Enabled" : "Disabled"} previous-year entry for Financial Year "${year.financialYear}".`,
    entityType: "FinancialYear",
    entityId: year._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(year);
}

// ---------------------------------------------------------------------------
// Year-end closing framework — pluggable so Budget/Fund/Invoice/Payroll
// modules contribute their own figures without this module knowing about
// them. Nothing is registered yet, so every summary is currently all-zero.
// ---------------------------------------------------------------------------

export interface ClosingContribution {
  allocatedAmount?: number;
  utilizedAmount?: number;
  committedAmount?: number;
  pendingAmount?: number;
  pendingTransactionCount?: number;
  blockingReasons?: string[];
}

export interface DepartmentClosingRow {
  nodeId: string;
  nodeName: string;
  allocatedAmount: number;
  utilizedAmount: number;
  committedAmount: number;
  pendingAmount: number;
  remainingAmount: number;
  hasPendingItems: boolean;
}

type ClosingSummaryProvider = (financialYearId: string) => Promise<ClosingContribution>;
type DepartmentSummaryProvider = (financialYearId: string) => Promise<DepartmentClosingRow[]>;

const closingSummaryProviders: ClosingSummaryProvider[] = [];
const departmentSummaryProviders: DepartmentSummaryProvider[] = [];

/** Future modules call this once, at startup, to plug their figures into every year-end closing summary. */
export function registerClosingSummaryProvider(provider: ClosingSummaryProvider): void {
  closingSummaryProviders.push(provider);
}

/** Future modules call this once, at startup, to contribute their own rows to the department-wise closing review. */
export function registerDepartmentSummaryProvider(provider: DepartmentSummaryProvider): void {
  departmentSummaryProviders.push(provider);
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
  canClose: boolean;
  blockingReasons: string[];
}

export async function getClosingSummary(id: string): Promise<ClosingSummaryDto> {
  const year = await findByIdOr404(id);

  const contributions = await Promise.all(
    closingSummaryProviders.map((provider) => provider(String(year._id)))
  );
  const departmentRows = await getDepartmentSummary(id);

  const allocatedAmount = contributions.reduce((sum, c) => sum + (c.allocatedAmount ?? 0), 0);
  const utilizedAmount = contributions.reduce((sum, c) => sum + (c.utilizedAmount ?? 0), 0);
  const committedAmount = contributions.reduce((sum, c) => sum + (c.committedAmount ?? 0), 0);
  const pendingAmount = contributions.reduce((sum, c) => sum + (c.pendingAmount ?? 0), 0);
  const remainingAmount = allocatedAmount - utilizedAmount - committedAmount - pendingAmount;
  const pendingTransactions = contributions.reduce((sum, c) => sum + (c.pendingTransactionCount ?? 0), 0);
  const departmentsWithRemainingFunds = departmentRows.filter((row) => row.remainingAmount > 0).length;

  const blockingReasons: string[] = contributions.flatMap((c) => c.blockingReasons ?? []);
  if (pendingTransactions > 0) {
    blockingReasons.push(
      `${pendingTransactions} pending transaction${pendingTransactions === 1 ? "" : "s"} require action.`
    );
  }
  if (year.isClosed) {
    blockingReasons.push("This Financial Year is already closed.");
  }
  if (year.isCurrent) {
    blockingReasons.push("Cannot close the current Financial Year — wait until the next Financial Year begins.");
  }

  return {
    financialYear: year.financialYear,
    status: year.status,
    allocatedAmount,
    utilizedAmount,
    committedAmount,
    pendingAmount,
    remainingAmount,
    pendingTransactions,
    departmentsWithRemainingFunds,
    canClose: blockingReasons.length === 0,
    blockingReasons,
  };
}

/**
 * Seeded from every active Organization Node at zero, then overlaid with
 * whatever real figures registered providers contribute — so the structure
 * is correct and testable now, before any Budget/Fund module exists.
 */
export async function getDepartmentSummary(id: string): Promise<DepartmentClosingRow[]> {
  const year = await findByIdOr404(id);

  const nodes = await OrganizationNodeModel.find({ status: "Active" }).select("name").lean();
  const rowsByNodeId = new Map<string, DepartmentClosingRow>(
    nodes.map((node) => [
      String(node._id),
      {
        nodeId: String(node._id),
        nodeName: node.name,
        allocatedAmount: 0,
        utilizedAmount: 0,
        committedAmount: 0,
        pendingAmount: 0,
        remainingAmount: 0,
        hasPendingItems: false,
      },
    ])
  );

  const contributedRows = (
    await Promise.all(departmentSummaryProviders.map((provider) => provider(String(year._id))))
  ).flat();
  for (const row of contributedRows) {
    rowsByNodeId.set(row.nodeId, row);
  }

  return [...rowsByNodeId.values()];
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
 * Throws unless `financialYearId` may currently receive new or modified
 * entries: must exist, must not be closed, and must be either the current
 * year or a previous year with previousYearEntryAllowed explicitly enabled.
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
  if (!year.isCurrent && !year.previousYearEntryAllowed) {
    throw new AppError(
      422,
      `Entries are not allowed for Financial Year "${year.financialYear}" — it is not the current year and previous-year entry has not been enabled by a Super Admin.`
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
    "financialYear previousYearEntryEnabledBy"
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
