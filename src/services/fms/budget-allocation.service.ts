import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { BudgetAllocationModel, type BudgetAllocationDocument } from "../../models/fms/BudgetAllocation";
import { FundTransferModel } from "../../models/fms/FundTransfer";
import { BudgetSetupModel } from "../../models/fms/BudgetSetup";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import { getOrCreateConfiguration } from "./configuration.service";
import { assertFinancialYearIsWritable } from "./financial-year.service";
import { reserveBudgetAmount, releaseBudgetAmount } from "./budget-setup.service";
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
import { NodeTypeModel } from "../../models/NodeType";
import { UserModel, type UserRole } from "../../models/User";
import type { FmsRole } from "../../models/fms/FmsUserNodeRole";
import type {
  BudgetAllocationExportQuery,
  BudgetAllocationListQuery,
  CreateBudgetAllocationInput,
  CreateBulkBudgetAllocationsInput,
} from "../../schemas/fms/budget-allocation.schema";

interface ActorContext {
  actorId: Types.ObjectId | null;
  actorRole?: UserRole;
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

export interface BudgetAllocationAttachmentDto {
  _id: string;
  originalName: string;
  fileUrl: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: Date;
}

export interface BudgetAllocationSourcePoolDto {
  budgetSetupId: string;
  amount: number;
}

export interface BudgetAllocationDto {
  _id: string;
  financialYearId: string;
  financialYear: FinancialYearRef | null;
  organizationRootNodeId: string;
  organizationNodeId: string;
  organizationNode: NodeRef | null;
  schemeHeadRootNodeId: string;
  headId: string | null;
  head: NodeRef | null;
  requireHeadAtCreation: boolean;
  amount: number;
  sourcePools: BudgetAllocationSourcePoolDto[];
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: string | null;
  maker: UserRef | null;
  verifierId: string | null;
  checkerId: string | null;
  holdingAmount: number;
  approvedAmount: number;
  transferredAmount: number;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  remarks: string | null;
  attachments: BudgetAllocationAttachmentDto[];
  createdBy: string | null;
  updatedBy: string | null;
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
    orgNodeMap: new Map<string, NodeRef>(
      orgNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])
    ),
    schemeHeadNodeMap: new Map<string, NodeRef>(
      schemeHeadNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])
    ),
    financialYearMap: new Map<string, FinancialYearRef>(
      financialYears.map((y) => [String(y._id), { _id: String(y._id), financialYear: y.financialYear }])
    ),
    makerMap: new Map<string, UserRef>(
      makers.map((u) => [String(u._id), { _id: String(u._id), fullname: u.fullname }])
    ),
  };
}

function serializeAttachments(
  attachments: BudgetAllocationDocument["attachments"]
): BudgetAllocationAttachmentDto[] {
  return attachments.map((attachment) => ({
    _id: String(attachment._id),
    originalName: attachment.originalName,
    fileUrl: attachment.fileUrl,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedBy: attachment.uploadedBy ? String(attachment.uploadedBy) : null,
    uploadedAt: attachment.uploadedAt,
  }));
}

function serializeSourcePools(
  sourcePools: BudgetAllocationDocument["sourcePools"]
): BudgetAllocationSourcePoolDto[] {
  return sourcePools.map((pool) => ({ budgetSetupId: String(pool.budgetSetupId), amount: pool.amount }));
}

function serialize(
  doc: BudgetAllocationDocument,
  maps: Awaited<ReturnType<typeof buildLookupMaps>>
): BudgetAllocationDto {
  const financialYearId = String(doc.financialYearId);
  const organizationNodeId = String(doc.organizationNodeId);
  const headId = doc.headId ? String(doc.headId) : null;
  const makerId = doc.makerId ? String(doc.makerId) : null;

  return {
    _id: String(doc._id),
    financialYearId,
    financialYear: maps.financialYearMap.get(financialYearId) ?? null,
    organizationRootNodeId: String(doc.organizationRootNodeId),
    organizationNodeId,
    organizationNode: maps.orgNodeMap.get(organizationNodeId) ?? null,
    schemeHeadRootNodeId: String(doc.schemeHeadRootNodeId),
    headId,
    head: headId ? (maps.schemeHeadNodeMap.get(headId) ?? null) : null,
    requireHeadAtCreation: doc.requireHeadAtCreation,
    amount: doc.amount,
    sourcePools: serializeSourcePools(doc.sourcePools),
    approvalStatus: doc.approvalStatus,
    workflowSnapshot: doc.workflowSnapshot,
    makerId,
    maker: makerId ? (maps.makerMap.get(makerId) ?? null) : null,
    verifierId: doc.verifierId ? String(doc.verifierId) : null,
    checkerId: doc.checkerId ? String(doc.checkerId) : null,
    holdingAmount: doc.holdingAmount,
    approvedAmount: doc.approvedAmount,
    transferredAmount: doc.transferredAmount,
    verifiedAt: doc.verifiedAt,
    approvedAt: doc.approvedAt,
    rejectionReason: doc.rejectionReason,
    rejectedBy: doc.rejectedBy ? String(doc.rejectedBy) : null,
    rejectedAt: doc.rejectedAt,
    remarks: doc.remarks,
    attachments: serializeAttachments(doc.attachments),
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Walks parentNodeId up from `candidateId`; true if it reaches `ancestorId` (or is it). */
export async function isOrganizationNodeSelfOrDescendant(
  candidateId: string,
  ancestorId: string
): Promise<boolean> {
  let currentId: string | null = candidateId;
  const visited = new Set<string>();

  while (currentId) {
    if (currentId === ancestorId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const current: { parentNodeId?: Types.ObjectId | null } | null = await OrganizationNodeModel.findById(
      currentId
    ).select("parentNodeId");
    currentId = current?.parentNodeId ? String(current.parentNodeId) : null;
  }
  return false;
}

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

export async function assertRootOrganizationNode(id: string): Promise<void> {
  const node = await OrganizationNodeModel.findById(id);
  if (!node) {
    throw new AppError(422, "The selected root Organization Node does not exist.", {
      organizationRootNodeId: ["Organization Node not found."],
    });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "The selected root Organization Node is inactive.", {
      organizationRootNodeId: ["Organization Node must be active."],
    });
  }
  if (node.parentNodeId) {
    throw new AppError(422, "Budget Allocation must be anchored to a root-level Organization Node.", {
      organizationRootNodeId: ["Select a root-level (top of hierarchy) Organization Node."],
    });
  }
}

export async function assertRootSchemeHeadNode(id: string): Promise<void> {
  const node = await SchemeHeadNodeModel.findById(id);
  if (!node) {
    throw new AppError(422, "The selected root Scheme/Head Node does not exist.", {
      schemeHeadRootNodeId: ["Scheme/Head Node not found."],
    });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "The selected root Scheme/Head Node is inactive.", {
      schemeHeadRootNodeId: ["Scheme/Head Node must be active."],
    });
  }
  if (node.parentNodeId) {
    throw new AppError(422, "Budget Allocation must be anchored to a root-level Scheme/Head Node.", {
      schemeHeadRootNodeId: ["Select a root-level (top of hierarchy) Scheme/Head Node."],
    });
  }
}

/** Escapes a string for safe use inside a RegExp constructor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Public sortBy key -> actual aggregation field path. Zod already restricts
 * sortBy to BUDGET_ALLOCATION_SORT_KEYS; this is the second half of that
 * allowlist, so an unvalidated string never reaches $sort.
 */
const SORT_FIELD_MAP: Record<string, string> = {
  createdAt: "createdAt",
  amount: "amount",
  organizationNode: "organizationNode.name",
  head: "head.name",
  financialYear: "financialYear.financialYear",
  maker: "maker.fullname",
};

interface AggregatedBudgetAllocationRow {
  _id: Types.ObjectId;
  financialYearId: Types.ObjectId;
  financialYear: { _id: Types.ObjectId; financialYear: string } | null;
  organizationRootNodeId: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  organizationNode: { _id: Types.ObjectId; name: string } | null;
  schemeHeadRootNodeId: Types.ObjectId;
  headId: Types.ObjectId | null;
  head: { _id: Types.ObjectId; name: string } | null;
  requireHeadAtCreation: boolean;
  amount: number;
  sourcePools: Array<{ budgetSetupId: Types.ObjectId; amount: number }>;
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: Types.ObjectId | null;
  maker: { _id: Types.ObjectId; fullname: string } | null;
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
  remarks: string | null;
  attachments: Array<{
    _id: Types.ObjectId;
    originalName: string;
    fileUrl: string;
    mimeType: string;
    size: number;
    uploadedBy: Types.ObjectId | null;
    uploadedAt: Date;
  }>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeAggregatedRow(row: AggregatedBudgetAllocationRow): BudgetAllocationDto {
  return {
    _id: String(row._id),
    financialYearId: String(row.financialYearId),
    financialYear: row.financialYear
      ? { _id: String(row.financialYear._id), financialYear: row.financialYear.financialYear }
      : null,
    organizationRootNodeId: String(row.organizationRootNodeId),
    organizationNodeId: String(row.organizationNodeId),
    organizationNode: row.organizationNode
      ? { _id: String(row.organizationNode._id), name: row.organizationNode.name }
      : null,
    schemeHeadRootNodeId: String(row.schemeHeadRootNodeId),
    headId: row.headId ? String(row.headId) : null,
    head: row.head ? { _id: String(row.head._id), name: row.head.name } : null,
    requireHeadAtCreation: row.requireHeadAtCreation,
    amount: row.amount,
    sourcePools: (row.sourcePools ?? []).map((pool) => ({
      budgetSetupId: String(pool.budgetSetupId),
      amount: pool.amount,
    })),
    approvalStatus: row.approvalStatus,
    workflowSnapshot: row.workflowSnapshot,
    makerId: row.makerId ? String(row.makerId) : null,
    maker: row.maker ? { _id: String(row.maker._id), fullname: row.maker.fullname } : null,
    verifierId: row.verifierId ? String(row.verifierId) : null,
    checkerId: row.checkerId ? String(row.checkerId) : null,
    holdingAmount: row.holdingAmount,
    approvedAmount: row.approvedAmount,
    transferredAmount: row.transferredAmount,
    verifiedAt: row.verifiedAt,
    approvedAt: row.approvedAt,
    rejectionReason: row.rejectionReason,
    rejectedBy: row.rejectedBy ? String(row.rejectedBy) : null,
    rejectedAt: row.rejectedAt,
    remarks: row.remarks,
    attachments: (row.attachments ?? []).map((attachment) => ({
      _id: String(attachment._id),
      originalName: attachment.originalName,
      fileUrl: attachment.fileUrl,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadedBy: attachment.uploadedBy ? String(attachment.uploadedBy) : null,
      uploadedAt: attachment.uploadedAt,
    })),
    createdBy: row.createdBy ? String(row.createdBy) : null,
    updatedBy: row.updatedBy ? String(row.updatedBy) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Shared by listBudgetAllocations (paginated) and the CSV export (unbounded
 * cursor). Search/sort need the $lookup to run first — organizationNode /
 * head / financialYear names only exist on referenced documents, so a plain
 * find().sort() can't match or order by them, and (critically) can't be
 * combined with server-side pagination without corrupting the total count.
 */
function buildBudgetAllocationsPipeline(
  query: BudgetAllocationListQuery | BudgetAllocationExportQuery,
  allowedNodeIds?: string[] | null,
  // Reports-only — Budget Management's own list/export never passes this,
  // so existing behavior there is unchanged. Validated against the
  // caller's allowed Head set by reports.service.ts's resolveEffectiveHeadIds
  // before reaching here (never trusts query.headId directly on its own).
  allowedHeadIds?: string[] | null
): mongoose.PipelineStage[] {
  const match: Record<string, unknown> = {};
  if (query.financialYearId) match.financialYearId = new Types.ObjectId(query.financialYearId);
  if (query.organizationRootNodeId) {
    match.organizationRootNodeId = new Types.ObjectId(query.organizationRootNodeId);
  }
  if (query.schemeHeadRootNodeId) match.schemeHeadRootNodeId = new Types.ObjectId(query.schemeHeadRootNodeId);
  if (query.organizationNodeId) match.organizationNodeId = new Types.ObjectId(query.organizationNodeId);
  if (query.headId) match.headId = new Types.ObjectId(query.headId);
  if (query.approvalStatus) match.approvalStatus = query.approvalStatus;
  if (query.maker) match.makerId = new Types.ObjectId(query.maker);
  if (query.dateFrom || query.dateTo) {
    const createdAt: Record<string, Date> = {};
    if (query.dateFrom) createdAt.$gte = query.dateFrom;
    if (query.dateTo) createdAt.$lte = query.dateTo;
    match.createdAt = createdAt;
  }
  if (query.amountFrom !== undefined || query.amountTo !== undefined) {
    const amount: Record<string, number> = {};
    if (query.amountFrom !== undefined) amount.$gte = query.amountFrom;
    if (query.amountTo !== undefined) amount.$lte = query.amountTo;
    match.amount = amount;
  }
  // Maker's view is restricted to their own assigned Organization Node(s) —
  // the allocation's actual target node, matching how its workflow itself
  // resolves (see resolveScope below). Verifier/Checker approval queues use
  // the same mechanism with their own actionable node set (see
  // listPendingApprovalsForStage).
  if (allowedNodeIds) {
    const allowedObjectIds = allowedNodeIds.map((id) => new Types.ObjectId(id));
    match.organizationNodeId = match.organizationNodeId
      ? { $eq: match.organizationNodeId, $in: allowedObjectIds }
      : { $in: allowedObjectIds };
  }
  if (allowedHeadIds) {
    const allowedHeadObjectIds = allowedHeadIds.map((id) => new Types.ObjectId(id));
    match.headId = match.headId
      ? { $eq: match.headId, $in: allowedHeadObjectIds }
      : { $in: allowedHeadObjectIds };
  }

  const pipeline: mongoose.PipelineStage[] = [
    { $match: match },
    {
      $lookup: {
        from: "organizationnodes",
        localField: "organizationNodeId",
        foreignField: "_id",
        as: "organizationNode",
      },
    },
    { $unwind: { path: "$organizationNode", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "schemeheadnodes",
        localField: "headId",
        foreignField: "_id",
        as: "head",
      },
    },
    { $unwind: { path: "$head", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "financialyears",
        localField: "financialYearId",
        foreignField: "_id",
        as: "financialYear",
      },
    },
    { $unwind: { path: "$financialYear", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        let: { makerId: "$makerId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$makerId"] } } },
          { $project: { fullname: 1 } },
        ],
        as: "maker",
      },
    },
    { $unwind: { path: "$maker", preserveNullAndEmptyArrays: true } },
  ];

  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), "i");
    pipeline.push({
      $match: {
        $or: [
          { remarks: regex },
          { "organizationNode.name": regex },
          { "head.name": regex },
          { "financialYear.financialYear": regex },
          { "maker.fullname": regex },
        ],
      },
    });
  }

  const sortField = SORT_FIELD_MAP[query.sortBy] ?? "createdAt";
  pipeline.push({ $sort: { [sortField]: query.sortOrder === "asc" ? 1 : -1 } });

  return pipeline;
}

export async function listBudgetAllocations(
  query: BudgetAllocationListQuery,
  allowedNodeIds?: string[] | null,
  allowedHeadIds?: string[] | null
): Promise<ListResult<BudgetAllocationDto>> {
  const pipeline = buildBudgetAllocationsPipeline(query, allowedNodeIds, allowedHeadIds);

  const [result] = await BudgetAllocationModel.aggregate([
    ...pipeline,
    {
      $facet: {
        items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
        totalCount: [{ $count: "count" }],
      },
    },
  ]);

  const total: number = result.totalCount[0]?.count ?? 0;

  return {
    items: (result.items as AggregatedBudgetAllocationRow[]).map(serializeAggregatedRow),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

/**
 * The Budget Verification / Budget Checker screens' data source — paginated,
 * filtered, sorted server-side, reusing listBudgetAllocations' own pipeline
 * so both surfaces share one implementation. Node scope comes from
 * getMyActionableNodeIds (the stage-appropriate assignment, expanded to
 * every ungoverned descendant — §11), never from anything the client sends;
 * an explicit organizationNodeId filter outside that scope yields an empty
 * page rather than an error, so it can't be used to probe for other
 * departments' data. approvalStatus is always forced to the stage's own
 * status — a Verifier can never even construct a query that returns
 * Checker-stage records.
 */
export async function listPendingApprovalsForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: BudgetAllocationListQuery
): Promise<ListResult<BudgetAllocationDto>> {
  const actionableNodeIds = await getMyActionableNodeIds(actor, stage);
  const allowedNodeIds = actionableNodeIds === "ALL" ? null : actionableNodeIds;

  if (query.organizationNodeId && allowedNodeIds && !allowedNodeIds.includes(query.organizationNodeId)) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }
  if (allowedNodeIds && allowedNodeIds.length === 0) {
    return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };
  }

  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  return listBudgetAllocations({ ...query, approvalStatus: forcedStatus }, allowedNodeIds);
}

/** CSV export counterpart of listPendingApprovalsForStage — same scope, same filters, unbounded cursor. */
export async function getPendingApprovalsCursorForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: BudgetAllocationExportQuery
) {
  const actionableNodeIds = await getMyActionableNodeIds(actor, stage);
  const allowedNodeIds = actionableNodeIds === "ALL" ? null : actionableNodeIds;

  if (query.organizationNodeId && allowedNodeIds && !allowedNodeIds.includes(query.organizationNodeId)) {
    return null;
  }
  if (allowedNodeIds && allowedNodeIds.length === 0) {
    return null;
  }

  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  return getBudgetAllocationsCursorForExport({ ...query, approvalStatus: forcedStatus }, allowedNodeIds);
}

export interface BulkWorkflowResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Processes a batch of verify/approve requests as one backend operation —
 * NOT a frontend loop calling the single-record endpoint N times. Each id
 * is independently re-validated and processed through the exact same
 * single-record function (same permission checks, same atomic transaction,
 * same workflow history + activity log entry), so a batch is never
 * all-or-nothing: one ineligible record (wrong stage, no permission,
 * already acted on) is reported as a failure without blocking or silently
 * skipping the rest (§6).
 */
async function processBulkWorkflowAction(
  ids: string[],
  action: (id: string) => Promise<unknown>
): Promise<BulkWorkflowResult> {
  const result: BulkWorkflowResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      await action(id);
      result.succeeded.push(id);
    } catch (error) {
      result.failed.push({
        id,
        reason: error instanceof AppError ? error.message : "Failed to process this transaction.",
      });
    }
  }
  return result;
}

export async function bulkVerifyBudgetAllocations(
  ids: string[],
  input: { remarks?: string },
  context: ActorContext
): Promise<BulkWorkflowResult> {
  return processBulkWorkflowAction(ids, (id) => verifyBudgetAllocation(id, input, context));
}

export async function bulkApproveBudgetAllocations(
  ids: string[],
  input: { remarks?: string },
  context: ActorContext
): Promise<BulkWorkflowResult> {
  return processBulkWorkflowAction(ids, (id) => approveBudgetAllocation(id, input, context));
}

export async function getBudgetAllocationById(
  id: string,
  allowedNodeIds?: string[] | null
): Promise<BudgetAllocationDto> {
  const doc = await BudgetAllocationModel.findById(id);
  if (!doc) throw new AppError(404, "Budget Allocation not found.");
  if (allowedNodeIds && !allowedNodeIds.includes(String(doc.organizationNodeId))) {
    throw new AppError(404, "Budget Allocation not found.");
  }
  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

interface ResolvedScope {
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  /** Every ACTIVE Budget Setup pooled for this scope, oldest first — drawn down in this order. */
  poolIds: Types.ObjectId[];
}

/**
 * Resolves and validates a (Financial Year, root Organization Node, root
 * Scheme/Head Node) scope, and finds every ACTIVE Budget Setup pooled under
 * it. Multiple Budget Setups are allowed for the same scope (an initial
 * sanction plus later top-up tranches) — they're combined into one fund,
 * oldest first, rather than requiring exactly one.
 */
async function resolveScope(scope: {
  financialYearId: string;
  organizationRootNodeId: string;
  schemeHeadRootNodeId: string;
}): Promise<ResolvedScope> {
  await assertFinancialYearIsWritable(scope.financialYearId);
  await assertRootOrganizationNode(scope.organizationRootNodeId);
  await assertRootSchemeHeadNode(scope.schemeHeadRootNodeId);

  const pools = await BudgetSetupModel.find({
    financialYearId: scope.financialYearId,
    organizationNodeId: scope.organizationRootNodeId,
    schemeHeadNodeId: scope.schemeHeadRootNodeId,
    status: "Active",
    // A Budget Setup only becomes real, poolable money once its own Maker/
    // Verifier/Checker approval completes — a pending or rejected one must
    // never be allocatable against, even though its originalAmount field
    // exists on the record (spec's GLOBAL FINANCIAL APPROVAL WORKFLOW).
    approvalStatus: "APPROVED",
  })
    .sort({ createdAt: 1 })
    .select("_id");

  if (pools.length === 0) {
    throw new AppError(422, "No active Budget Setup exists for this Financial Year and node combination.", {
      organizationRootNodeId: ["Create a Budget Setup for this scope first."],
    });
  }

  return {
    financialYearId: new Types.ObjectId(scope.financialYearId),
    organizationRootNodeId: new Types.ObjectId(scope.organizationRootNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(scope.schemeHeadRootNodeId),
    poolIds: pools.map((pool) => pool._id),
  };
}

/**
 * Reserves up to `desiredAmount` from a single Budget Setup, returning
 * however much was actually reserved (0 if it has no remaining balance).
 * Tries the full desired amount atomically first; if that fails only
 * because the pool doesn't have that much left, re-reads its current
 * remaining balance and makes one more atomic attempt for exactly that —
 * safe under concurrent requests since both attempts go through
 * reserveBudgetAmount's own atomic, race-free update.
 */
async function reserveUpToFromPool(
  budgetSetupId: Types.ObjectId,
  desiredAmount: number,
  context: ActorContext,
  session: mongoose.ClientSession
): Promise<number> {
  if (desiredAmount <= 0) return 0;

  try {
    await reserveBudgetAmount(String(budgetSetupId), desiredAmount, context, session);
    return desiredAmount;
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode !== 409) throw error;
  }

  const pool = await BudgetSetupModel.findById(budgetSetupId)
    .session(session)
    .select("originalAmount allocatedAmount status");
  if (!pool || pool.status !== "Active") return 0;
  const actuallyRemaining = pool.originalAmount - pool.allocatedAmount;
  if (actuallyRemaining <= 0) return 0;

  try {
    await reserveBudgetAmount(String(budgetSetupId), actuallyRemaining, context, session);
    return actuallyRemaining;
  } catch {
    return 0;
  }
}

/**
 * Draws `amount` from the scope's pooled Budget Setups, oldest first,
 * splitting across as many as necessary. Re-reads each pool's live balance
 * as it goes (within the same transaction session, so it sees its own
 * writes), so sequential calls within the same bulk submission correctly
 * see what earlier rows already drew down. If the pools combined can't
 * cover the full amount, this throws and the caller's enclosing
 * session.withTransaction() discards every reservation made in this call —
 * no manual compensating release needed, the transaction itself is
 * all-or-nothing (GLOBAL_RULES §8).
 */
async function reserveFromScope(
  poolIds: Types.ObjectId[],
  amount: number,
  context: ActorContext,
  session: mongoose.ClientSession
): Promise<Array<{ budgetSetupId: Types.ObjectId; amount: number }>> {
  let remaining = amount;
  const breakdown: Array<{ budgetSetupId: Types.ObjectId; amount: number }> = [];

  for (const poolId of poolIds) {
    if (remaining <= 0) break;
    const reserved = await reserveUpToFromPool(poolId, remaining, context, session);
    if (reserved > 0) {
      breakdown.push({ budgetSetupId: poolId, amount: reserved });
      remaining -= reserved;
    }
  }

  if (remaining > 0) {
    // Every pool in poolIds was already drawn down to its actual max above
    // (reserveUpToFromPool never leaves a pool partially short) — so
    // `amount - remaining` IS the true total that was available across all
    // of them, before this call. Re-querying the pools here would instead
    // read their *mid-transaction* state (already reserved, not yet rolled
    // back), which would wrongly report ~0 available.
    const totalAvailable = amount - remaining;
    throw new AppError(
      409,
      "Requested amount exceeds the total remaining budget across all Budget Setups for this scope.",
      { amount: [`Only ${totalAvailable} remains available across ${poolIds.length} Budget Setup(s).`] }
    );
  }

  return breakdown;
}

type ReceivedPoolKind = "BUDGET_ALLOCATION" | "FUND_TRANSFER";
interface ReceivedPoolRef {
  kind: ReceivedPoolKind;
  poolId: Types.ObjectId;
}
export interface ReceivedPoolReservation extends ReceivedPoolRef {
  amount: number;
}

/**
 * Both models share the three fields this reservation logic touches
 * (`amount`, `subAllocatedAmount`, `approvalStatus`) — narrowed to just
 * those so a single code path can operate on either model's documents
 * without TypeScript choking on their otherwise-unrelated full shapes.
 */
interface ReceivedPoolCollection {
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: { session: mongoose.ClientSession }): Promise<unknown>;
  findById(id: Types.ObjectId): {
    session(s: mongoose.ClientSession): { select(fields: string): Promise<{ amount: number; subAllocatedAmount: number; approvalStatus: string } | null> };
  };
}

function receivedPoolModel(kind: ReceivedPoolKind): ReceivedPoolCollection {
  return (kind === "BUDGET_ALLOCATION" ? BudgetAllocationModel : FundTransferModel) as unknown as ReceivedPoolCollection;
}

/**
 * Every pool `nodeId` can be said to have "received" — its own APPROVED
 * BudgetAllocation record(s) AND any APPROVED FundTransfer(s) pulled/
 * returned INTO it (see FundTransfer.ts) — oldest first across both. A node
 * that received money purely via a Pull/Return is just as able to
 * sub-allocate it onward, or itself pull/return it further up, as one that
 * received it as a direct Budget Allocation.
 */
async function findReceivedPoolRefs(
  nodeId: string,
  scope: { financialYearId: Types.ObjectId | string; organizationRootNodeId: Types.ObjectId | string; schemeHeadRootNodeId: Types.ObjectId | string },
  session: mongoose.ClientSession
): Promise<ReceivedPoolRef[]> {
  const matchBase = {
    financialYearId: scope.financialYearId,
    organizationRootNodeId: scope.organizationRootNodeId,
    schemeHeadRootNodeId: scope.schemeHeadRootNodeId,
    approvalStatus: "APPROVED" as const,
  };
  // Sequential, not Promise.all — a MongoDB session can only have one
  // operation in flight at a time; running both queries concurrently on
  // the same transaction session throws "ConflictingOperationInProgress".
  const allocations = await BudgetAllocationModel.find({ ...matchBase, organizationNodeId: nodeId })
    .session(session)
    .sort({ createdAt: 1 })
    .select("_id");
  const transfers = await FundTransferModel.find({ ...matchBase, destinationNodeId: nodeId })
    .session(session)
    .sort({ createdAt: 1 })
    .select("_id");
  return [
    ...allocations.map((doc) => ({ kind: "BUDGET_ALLOCATION" as const, poolId: doc._id })),
    ...transfers.map((doc) => ({ kind: "FUND_TRANSFER" as const, poolId: doc._id })),
  ];
}

/**
 * Reserves up to `desiredAmount` of headroom from one specific received
 * pool record, against its own `subAllocatedAmount` counter — the atomic
 * `findOneAndUpdate` guard is what makes two concurrent draws against the
 * same pool unable to jointly over-draw it (GLOBAL_RULES §10).
 */
async function reserveUpToFromReceivedPool(
  ref: ReceivedPoolRef,
  desiredAmount: number,
  session: mongoose.ClientSession
): Promise<number> {
  if (desiredAmount <= 0) return 0;
  const Model = receivedPoolModel(ref.kind);

  const updated = await Model.findOneAndUpdate(
    {
      _id: ref.poolId,
      approvalStatus: "APPROVED",
      $expr: { $lte: [{ $add: ["$subAllocatedAmount", desiredAmount] }, "$amount"] },
    },
    { $inc: { subAllocatedAmount: desiredAmount } },
    { session }
  );
  if (updated) return desiredAmount;

  const pool = await Model.findById(ref.poolId).session(session).select("amount subAllocatedAmount approvalStatus");
  if (!pool || pool.approvalStatus !== "APPROVED") return 0;
  const actuallyRemaining = pool.amount - pool.subAllocatedAmount;
  if (actuallyRemaining <= 0) return 0;

  const retried = await Model.findOneAndUpdate(
    {
      _id: ref.poolId,
      approvalStatus: "APPROVED",
      $expr: { $lte: [{ $add: ["$subAllocatedAmount", actuallyRemaining] }, "$amount"] },
    },
    { $inc: { subAllocatedAmount: actuallyRemaining } },
    { session }
  );
  return retried ? actuallyRemaining : 0;
}

/**
 * Reserves `amount` out of what `nodeId` itself actually received (its own
 * received pools, oldest first — see findReceivedPoolRefs) — the one shared
 * capacity counter that every kind of outgoing commitment from this node
 * draws against, whether that's sub-allocating further down to its own
 * children (reserveFromParentIfNeeded below) or pulling/returning money
 * back up to its parent (fund-transfer.service.ts). All of them draw from
 * the exact same pool, so a node's total outgoing commitments can never
 * jointly exceed what it actually received, regardless of which direction
 * they go or how it originally arrived.
 */
export async function reserveFromNodeOwnReceivedPool(
  nodeId: string,
  amount: number,
  scope: { financialYearId: Types.ObjectId | string; organizationRootNodeId: Types.ObjectId | string; schemeHeadRootNodeId: Types.ObjectId | string },
  session: mongoose.ClientSession,
  errorKeyPrefix = ""
): Promise<ReceivedPoolReservation[]> {
  const pools = await findReceivedPoolRefs(nodeId, scope, session);

  if (pools.length === 0) {
    throw new AppError(
      422,
      "This Organization Node has not received an approved Budget Allocation yet — there is nothing available.",
      { [`${errorKeyPrefix}amount`]: ["Node has no approved budget to draw from."] }
    );
  }

  let remaining = amount;
  const breakdown: ReceivedPoolReservation[] = [];
  for (const pool of pools) {
    if (remaining <= 0) break;
    const reserved = await reserveUpToFromReceivedPool(pool, remaining, session);
    if (reserved > 0) {
      breakdown.push({ ...pool, amount: reserved });
      remaining -= reserved;
    }
  }

  if (remaining > 0) {
    const totalAvailable = amount - remaining;
    throw new AppError(
      409,
      `Insufficient available budget. Maximum available amount is ${totalAvailable}.`,
      { [`${errorKeyPrefix}amount`]: [`Only ${totalAvailable} remains available.`] }
    );
  }

  return breakdown;
}

async function reserveFromParentIfNeeded(
  organizationNodeId: string,
  amount: number,
  scope: ResolvedScope,
  session: mongoose.ClientSession,
  errorKeyPrefix = ""
): Promise<ReceivedPoolReservation[]> {
  const node = await OrganizationNodeModel.findById(organizationNodeId).session(session).select("parentNodeId");
  if (!node?.parentNodeId) return [];
  if (String(node.parentNodeId) === String(scope.organizationRootNodeId)) return [];

  try {
    return await reserveFromNodeOwnReceivedPool(String(node.parentNodeId), amount, scope, session, errorKeyPrefix);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 422) {
      throw new AppError(
        422,
        "The parent Organization Node has not received an approved Budget Allocation yet — there is nothing available to sub-allocate from it.",
        { [`${errorKeyPrefix}amount`]: ["Parent node has no approved budget to allocate from."] }
      );
    }
    throw error;
  }
}

/** Reverses every reservation made by `reserveFromNodeOwnReceivedPool`/`reserveFromParentIfNeeded` — symmetric, floored at the pool's own committed amount. */
export async function releaseToParentPool(
  parentSourcePools: ReceivedPoolReservation[],
  session: mongoose.ClientSession
): Promise<void> {
  for (const pool of parentSourcePools) {
    const Model = receivedPoolModel(pool.kind);
    await Model.findOneAndUpdate(
      { _id: pool.poolId, $expr: { $gte: ["$subAllocatedAmount", pool.amount] } },
      { $inc: { subAllocatedAmount: -pool.amount } },
      { session }
    );
  }
}

/**
 * Validates one (organizationNodeId, headId, amount) row against a resolved
 * scope and the live Require Head configuration. Shared by the single-row
 * and bulk create paths so both enforce identical rules — §4: the server,
 * never the frontend, decides whether Head is mandatory. `errorKeyPrefix`
 * lets bulk rows report which row index failed.
 */
async function validateAllocationRow(
  scope: ResolvedScope,
  row: { organizationNodeId: string; headId?: string | null; amount: number },
  requireHead: boolean,
  errorKeyPrefix = ""
): Promise<{ headId: Types.ObjectId | null }> {
  const orgNode = await OrganizationNodeModel.findById(row.organizationNodeId);
  if (!orgNode) {
    throw new AppError(422, "The selected Organization Node does not exist.", {
      [`${errorKeyPrefix}organizationNodeId`]: ["Organization Node not found."],
    });
  }
  if (orgNode.status !== "Active") {
    throw new AppError(422, "The selected Organization Node is inactive.", {
      [`${errorKeyPrefix}organizationNodeId`]: ["Organization Node must be active."],
    });
  }
  const orgInScope = await isOrganizationNodeSelfOrDescendant(
    row.organizationNodeId,
    String(scope.organizationRootNodeId)
  );
  if (!orgInScope) {
    throw new AppError(
      422,
      "The selected Organization Node does not belong to this scope's Organization hierarchy.",
      { [`${errorKeyPrefix}organizationNodeId`]: ["Node must be under the selected root Organization Node."] }
    );
  }

  if (requireHead && !row.headId) {
    throw new AppError(422, "A Head must be selected for this allocation.", {
      [`${errorKeyPrefix}headId`]: ["Head is required by the current Fund/Budget Allocation configuration."],
    });
  }

  let headId: Types.ObjectId | null = null;
  if (row.headId) {
    const headNode = await SchemeHeadNodeModel.findById(row.headId);
    if (!headNode) {
      throw new AppError(422, "The selected Head does not exist.", {
        [`${errorKeyPrefix}headId`]: ["Head not found."],
      });
    }
    if (headNode.status !== "Active") {
      throw new AppError(422, "The selected Head is inactive.", {
        [`${errorKeyPrefix}headId`]: ["Head must be active."],
      });
    }
    const headInScope = await isSchemeHeadSelfOrDescendant(row.headId, String(scope.schemeHeadRootNodeId));
    if (!headInScope) {
      throw new AppError(
        422,
        "The selected Head does not belong to this scope's Scheme/Head hierarchy.",
        { [`${errorKeyPrefix}headId`]: ["Head must be under the selected root Scheme/Head Node."] }
      );
    }
    headId = new Types.ObjectId(row.headId);
  }

  return { headId };
}

export async function createBudgetAllocation(
  input: CreateBudgetAllocationInput,
  context: ActorContext
): Promise<BudgetAllocationDto> {
  const scope = await resolveScope(input);

  // §4 — the server, not the frontend, decides whether Head is mandatory.
  const configuration = await getOrCreateConfiguration();
  const requireHead = configuration.allocationRequireHead;

  const { headId } = await validateAllocationRow(scope, input, requireHead);

  // GLOBAL FINANCIAL APPROVAL WORKFLOW §2/§12 — the workflow applies to the
  // ALLOCATION's specific target Organization Node (e.g. "BAEG"), not the
  // scope's root, since Maker/Verifier/Checker are assigned per node.
  const actorId = requireActorId(context);
  await assertMakerPermission({ actorId, actorRole: requireActorRole(context) }, input.organizationNodeId);
  const workflow = await resolveWorkflowForNode(input.organizationNodeId);
  const autoApproved = workflow.initialStatus === "APPROVED";

  // The reservation happens unconditionally at Maker submission regardless
  // of the workflow — that IS what "Holding Amount" means here (§8): the
  // money is genuinely set aside immediately, never a soft/advisory hold.
  // Reserving from the pool(s) and creating the allocation record happen in
  // one MongoDB transaction — if either step fails, both roll back together
  // rather than leaving money reserved with no matching allocation (or vice
  // versa). See GLOBAL_RULES §8.
  const session = await mongoose.startSession();
  let created: BudgetAllocationDocument;
  let sourcePools: Array<{ budgetSetupId: Types.ObjectId; amount: number }>;
  try {
    const result = await session.withTransaction(async () => {
      const pools = await reserveFromScope(scope.poolIds, input.amount, context, session);
      const parentPools = await reserveFromParentIfNeeded(input.organizationNodeId, input.amount, scope, session);
      const [doc] = await BudgetAllocationModel.create(
        [
          {
            financialYearId: scope.financialYearId,
            organizationRootNodeId: scope.organizationRootNodeId,
            organizationNodeId: input.organizationNodeId,
            schemeHeadRootNodeId: scope.schemeHeadRootNodeId,
            headId,
            requireHeadAtCreation: requireHead,
            amount: input.amount,
            sourcePools: pools,
            parentSourcePools: parentPools,
            approvalStatus: workflow.initialStatus,
            workflowSnapshot: workflow.snapshot,
            makerId: actorId,
            holdingAmount: autoApproved ? 0 : input.amount,
            approvedAmount: autoApproved ? input.amount : 0,
            transferredAmount: autoApproved ? input.amount : 0,
            approvedAt: autoApproved ? new Date() : null,
            remarks: input.remarks ?? null,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session }
      );

      await recordWorkflowEvent(
        { module: "BUDGET_ALLOCATION", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.amount },
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

      return { doc, pools };
    });
    created = result.doc;
    sourcePools = result.pools;
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "BUDGET_ALLOCATION_CREATED",
    module: "FINANCE",
    description: `Maker allocated ${input.amount} to Organization Node ${input.organizationNodeId}${
      headId ? ` (Head ${String(headId)})` : ""
    } — requireHead=${requireHead}, drawn from ${sourcePools.length} pool(s), ${workflow.initialStatus}.`,
    entityType: "BudgetAllocation",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(created, maps);
}

/**
 * Creates several allocations (one per department row) from the same
 * pooled scope in one submission (the bulk allocation form). Each row is
 * reserved against the pool independently, in order — so an earlier row
 * can exhaust one Budget Setup and spill into the next before a later row
 * runs, and each row's `sourcePools` breakdown reflects exactly where its
 * own money came from. If a later row fails, every row successfully
 * reserved earlier in this same call is rolled back before the error
 * propagates, keeping the whole submission all-or-nothing.
 */
export async function createBulkBudgetAllocations(
  input: CreateBulkBudgetAllocationsInput,
  context: ActorContext
): Promise<BudgetAllocationDto[]> {
  const scope = await resolveScope(input);

  const configuration = await getOrCreateConfiguration();
  const requireHead = configuration.allocationRequireHead;
  const actorId = requireActorId(context);
  const actorRole = requireActorRole(context);

  // Each row can target a DIFFERENT department, and Maker/Verifier/Checker
  // is assigned per node (§12) — so every row's target node gets its own
  // permission check and its own resolved workflow, checked up front
  // before any money moves, so a batch either fully qualifies or nothing
  // is reserved.
  const validatedRows: Array<{
    organizationNodeId: string;
    headId: Types.ObjectId | null;
    amount: number;
    workflow: Awaited<ReturnType<typeof resolveWorkflowForNode>>;
    errorKeyPrefix: string;
  }> = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    const errorKeyPrefix = `rows.${index}.`;
    const { headId } = await validateAllocationRow(scope, row, requireHead, errorKeyPrefix);
    await assertMakerPermission({ actorId, actorRole }, row.organizationNodeId);
    const workflow = await resolveWorkflowForNode(row.organizationNodeId);
    validatedRows.push({ organizationNodeId: row.organizationNodeId, headId, amount: row.amount, workflow, errorKeyPrefix });
  }

  const totalAmount = validatedRows.reduce((sum, row) => sum + row.amount, 0);

  // Reserving every row's share of the pool(s) and creating all the
  // allocation records happen in one MongoDB transaction — a later row's
  // failure (e.g. the pools run out) rolls back every earlier row's
  // reservation too, so the whole batch is genuinely all-or-nothing
  // (GLOBAL_RULES §8), with no manual compensating release needed.
  const session = await mongoose.startSession();
  let created: BudgetAllocationDocument[];
  try {
    created = await session.withTransaction(async () => {
      const reservedRows: Array<{
        row: (typeof validatedRows)[number];
        sourcePools: Awaited<ReturnType<typeof reserveFromScope>>;
        parentPools: Awaited<ReturnType<typeof reserveFromParentIfNeeded>>;
      }> = [];
      for (const row of validatedRows) {
        const sourcePools = await reserveFromScope(scope.poolIds, row.amount, context, session);
        const parentPools = await reserveFromParentIfNeeded(
          row.organizationNodeId,
          row.amount,
          scope,
          session,
          row.errorKeyPrefix
        );
        reservedRows.push({ row, sourcePools, parentPools });
      }

      const docs = await BudgetAllocationModel.create(
        reservedRows.map(({ row, sourcePools, parentPools }) => {
          const autoApproved = row.workflow.initialStatus === "APPROVED";
          return {
            financialYearId: scope.financialYearId,
            organizationRootNodeId: scope.organizationRootNodeId,
            organizationNodeId: new Types.ObjectId(row.organizationNodeId),
            schemeHeadRootNodeId: scope.schemeHeadRootNodeId,
            headId: row.headId,
            requireHeadAtCreation: requireHead,
            amount: row.amount,
            sourcePools,
            parentSourcePools: parentPools,
            approvalStatus: row.workflow.initialStatus,
            workflowSnapshot: row.workflow.snapshot,
            makerId: actorId,
            holdingAmount: autoApproved ? 0 : row.amount,
            approvedAmount: autoApproved ? row.amount : 0,
            transferredAmount: autoApproved ? row.amount : 0,
            approvedAt: autoApproved ? new Date() : null,
            remarks: input.remarks ?? null,
            createdBy: actorId,
            updatedBy: actorId,
          };
        }),
        { session }
      );

      for (const doc of docs) {
        await recordWorkflowEvent(
          { module: "BUDGET_ALLOCATION", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.amount },
          {
            action: "MAKER_SUBMITTED",
            userId: actorId,
            userRole: "Maker",
            previousStatus: null,
            newStatus: doc.approvalStatus,
            holdingAmount: doc.holdingAmount,
            ipAddress: context.ipAddress,
          },
          session
        );
      }

      return docs;
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: actorId,
    action: "BUDGET_ALLOCATION_CREATED",
    module: "FINANCE",
    description: `Maker bulk-allocated ${totalAmount} across ${created.length} department(s) — requireHead=${requireHead}, pooled across ${scope.poolIds.length} Budget Setup(s).`,
    entityType: "BudgetAllocation",
    entityId: created[0]?._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return created.map((doc) => serialize(doc, maps));
}

export interface BudgetAllocationNodeFinancials {
  organizationNodeId: string;
  /** What this node has actually RECEIVED — APPROVED allocations targeting it directly. 0 while still pending. */
  receivedAmount: number;
  /** What this node has received OR has pending, i.e. non-rejected — what it has "spoken for" of its own incoming pool. */
  heldAmount: number;
  /** What this node has handed onward to its own direct children (non-rejected — reserved the moment it's submitted, same Holding semantics as everywhere else). */
  subAllocatedAmount: number;
  /** receivedAmount - subAllocatedAmount — this node's own balance still free to sub-allocate further. */
  remainingAmount: number;
}

/**
 * Per-Organization-Node financial breakdown under a scope — the "Budget
 * Allocated" / "Remaining Fund" figures on the bulk allocation form. This
 * is tree-aware: a department that has itself received money and then
 * sub-allocated part of it to child departments (e.g. "Tech" receiving
 * ₹78,000 and handing ₹5,000 to "Mobile Development" + ₹2,000 to
 * "QA Team") must show its OWN remaining balance (₹71,000), not the shared
 * root pool's balance — the root pool figure is a separate, coarser number
 * (see BudgetAvailabilityTiles) that already gates whether a NEW allocation
 * can be created at all; this is about what each department has left of
 * what it was itself handed.
 */
export async function getBudgetAllocationNodeTotals(scope: {
  financialYearId: string;
  organizationRootNodeId: string;
  schemeHeadRootNodeId: string;
}): Promise<BudgetAllocationNodeFinancials[]> {
  const matchBase = {
    financialYearId: new Types.ObjectId(scope.financialYearId),
    organizationRootNodeId: new Types.ObjectId(scope.organizationRootNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(scope.schemeHeadRootNodeId),
  };

  const [receivedRows, heldRows, allOrgNodes] = await Promise.all([
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { ...matchBase, approvalStatus: "APPROVED" } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$amount" } } },
    ]),
    // Rejected allocations already released their Holding back to the pool
    // (see rejectBudgetAllocation) — they must not still count as "held" here.
    BudgetAllocationModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { ...matchBase, approvalStatus: { $nin: ["REJECTED_BY_VERIFIER", "REJECTED_BY_CHECKER"] } } },
      { $group: { _id: "$organizationNodeId", amount: { $sum: "$amount" } } },
    ]),
    OrganizationNodeModel.find({ status: "Active" }).select("_id parentNodeId").lean(),
  ]);

  const receivedMap = new Map(receivedRows.map((r) => [String(r._id), r.amount]));
  const heldMap = new Map(heldRows.map((r) => [String(r._id), r.amount]));
  const parentById = new Map(allOrgNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));

  const subAllocatedMap = new Map<string, number>();
  for (const node of allOrgNodes) {
    const nodeId = String(node._id);
    const parentId = parentById.get(nodeId);
    if (!parentId) continue;
    const heldByThisNode = heldMap.get(nodeId) ?? 0;
    if (heldByThisNode === 0) continue;
    subAllocatedMap.set(parentId, (subAllocatedMap.get(parentId) ?? 0) + heldByThisNode);
  }

  const allNodeIds = new Set<string>([...receivedMap.keys(), ...heldMap.keys(), ...subAllocatedMap.keys()]);

  return Array.from(allNodeIds).map((organizationNodeId) => {
    const receivedAmount = receivedMap.get(organizationNodeId) ?? 0;
    const subAllocatedAmount = subAllocatedMap.get(organizationNodeId) ?? 0;
    return {
      organizationNodeId,
      receivedAmount,
      heldAmount: heldMap.get(organizationNodeId) ?? 0,
      subAllocatedAmount,
      remainingAmount: receivedAmount - subAllocatedAmount,
    };
  });
}

export interface AllocatableNodeDto {
  organizationNodeId: string;
  name: string;
  nodeType: string | null;
  parentNodeId: string | null;
}

/**
 * Every Organization Node a Maker may pick as an allocation target right
 * now — their own assigned node(s) plus every descendant that inherits one
 * of those nodes' workflow (§11/§17: a Department Maker must not be able to
 * manually select another department's row to gain access, so the row list
 * itself has to be pre-scoped server-side, not just the create action).
 * Super Admin/Admin get `null` — they aren't restricted, the frontend uses
 * the full Organization Tree for them instead.
 */
export async function getMyAllocatableNodes(actor: ActorForPermission): Promise<AllocatableNodeDto[] | null> {
  const allowedNodeIds = await getAllowedNodeIdsForList(actor);
  if (allowedNodeIds === null) return null;
  if (allowedNodeIds.length === 0) return [];

  const nodes = await OrganizationNodeModel.find({ _id: { $in: allowedNodeIds }, status: "Active" })
    .select("name nodeTypeId parentNodeId")
    .lean();
  const nodeTypeIds = [...new Set(nodes.map((n) => n.nodeTypeId).filter(Boolean).map((id) => String(id)))];
  const nodeTypes = nodeTypeIds.length > 0
    ? await NodeTypeModel.find({ _id: { $in: nodeTypeIds } }).select("name").lean()
    : [];
  const nodeTypeNameById = new Map(nodeTypes.map((t) => [String(t._id), t.name]));

  return nodes.map((node) => ({
    organizationNodeId: String(node._id),
    name: node.name,
    nodeType: nodeTypeNameById.get(String(node.nodeTypeId)) ?? null,
    parentNodeId: node.parentNodeId ? String(node.parentNodeId) : null,
  }));
}

export async function verifyBudgetAllocation(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<BudgetAllocationDto> {
  const doc = await BudgetAllocationModel.findById(id);
  if (!doc) throw new AppError(404, "Budget Allocation not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION") {
    throw new AppError(422, "This Budget Allocation is not pending verification.");
  }
  const actorId = requireActorId(context);
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    actorId
  );
  await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const { nextStatus, isFinal } = computeVerifyTransition(doc.workflowSnapshot);
  const previousStatus = doc.approvalStatus;

  doc.verifierId = actorId;
  doc.verifiedAt = new Date();
  doc.approvalStatus = nextStatus;
  if (isFinal) {
    doc.holdingAmount = 0;
    doc.approvedAmount = doc.amount;
    doc.transferredAmount = doc.amount;
    doc.approvedAt = new Date();
  }
  doc.updatedBy = actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "BUDGET_ALLOCATION", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.amount },
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
    action: "BUDGET_ALLOCATION_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified Budget Allocation ${String(doc._id)}${isFinal ? " — final approval, funds transferred." : "."}`,
    entityType: "BudgetAllocation",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function approveBudgetAllocation(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<BudgetAllocationDto> {
  const doc = await BudgetAllocationModel.findById(id);
  if (!doc) throw new AppError(404, "Budget Allocation not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Budget Allocation is not pending Checker approval.");
  }
  const actorId = requireActorId(context);
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    actorId
  );
  await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));

  const previousStatus = doc.approvalStatus;
  doc.checkerId = actorId;
  doc.approvalStatus = "APPROVED";
  doc.holdingAmount = 0;
  doc.approvedAmount = doc.amount;
  doc.transferredAmount = doc.amount;
  doc.approvedAt = new Date();
  doc.updatedBy = actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "BUDGET_ALLOCATION", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.amount },
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
    action: "BUDGET_ALLOCATION_APPROVED",
    module: "FINANCE",
    description: `Checker approved Budget Allocation ${String(doc._id)} — funds transferred.`,
    entityType: "BudgetAllocation",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

/**
 * Rejecting a Budget Allocation releases its Holding back to the exact
 * Budget Setup pool(s) it was drawn from (its `sourcePools` breakdown) —
 * unlike Budget Setup's own rejection (nothing to release to, it's the top
 * of the money chain), an allocation's Holding really did come out of a
 * real Budget Setup's remaining balance, so it has to really go back.
 */
export async function rejectBudgetAllocation(
  id: string,
  input: { reason: string },
  context: ActorContext
): Promise<BudgetAllocationDto> {
  const doc = await BudgetAllocationModel.findById(id);
  if (!doc) throw new AppError(404, "Budget Allocation not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION" && doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Budget Allocation is not pending any approval.");
  }
  const actorId = requireActorId(context);
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    actorId
  );

  const isVerifierStage = doc.approvalStatus === "PENDING_VERIFICATION";
  if (isVerifierStage) {
    await assertVerifierPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  } else {
    await assertCheckerPermission({ actorId, actorRole: requireActorRole(context) }, String(doc.organizationNodeId));
  }

  const previousStatus = doc.approvalStatus;

  // Releasing every source pool and flipping the allocation's own status
  // happen in one MongoDB transaction — a crash or error partway through
  // must never leave money released back to a pool while the allocation
  // record still shows pending (or vice versa). See GLOBAL_RULES §8.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const pool of doc.sourcePools) {
        await releaseBudgetAmount(String(pool.budgetSetupId), pool.amount, context, session);
      }
      await releaseToParentPool(doc.parentSourcePools, session);

      doc.approvalStatus = isVerifierStage ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
      doc.rejectionReason = input.reason;
      doc.rejectedBy = actorId;
      doc.rejectedAt = new Date();
      doc.holdingAmount = 0;
      if (isVerifierStage) doc.verifierId = actorId;
      else doc.checkerId = actorId;
      doc.updatedBy = actorId;
      await doc.save({ session });

      await recordWorkflowEvent(
        { module: "BUDGET_ALLOCATION", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.amount },
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
    action: isVerifierStage ? "BUDGET_ALLOCATION_REJECTED_BY_VERIFIER" : "BUDGET_ALLOCATION_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected Budget Allocation ${String(doc._id)}: ${input.reason} — Holding released.`,
    entityType: "BudgetAllocation",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

/**
 * Streams every matching row as a cursor (never materializes the full
 * result set in memory) for the CSV export — same filters/search/sort as
 * the list, just unbounded. Search is applied inside the pipeline, so every
 * matching row is included regardless of position (unlike a post-hoc filter
 * over an already-paginated slice).
 */
export function getBudgetAllocationsCursorForExport(
  query: BudgetAllocationExportQuery,
  allowedNodeIds?: string[] | null
) {
  const pipeline = buildBudgetAllocationsPipeline(query, allowedNodeIds);
  return BudgetAllocationModel.aggregate<AggregatedBudgetAllocationRow>(pipeline).cursor();
}

/**
 * Attaches one uploaded Reference Document to every allocation row named in
 * `allocationIds` — used right after a bulk submission, since that single
 * form-level document has no separate "batch" entity of its own to live on,
 * so it gets copied onto each row created in that batch instead.
 */
export async function addBudgetAllocationDocuments(
  allocationIds: string[],
  file: Express.Multer.File,
  context: ActorContext
): Promise<BudgetAllocationDto[]> {
  const docs = await BudgetAllocationModel.find({ _id: { $in: allocationIds } });
  if (docs.length !== allocationIds.length) {
    throw new AppError(404, "One or more Budget Allocations were not found.");
  }

  const attachment = {
    fileName: file.filename,
    originalName: file.originalname,
    fileUrl: `/uploads/budget-allocations/${file.filename}`,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: context.actorId,
    uploadedAt: new Date(),
  };

  for (const doc of docs) {
    doc.attachments.push(attachment);
    doc.updatedBy = context.actorId;
    await doc.save();
  }

  await logActivity({
    user: context.actorId,
    action: "BUDGET_ALLOCATION_DOCUMENT_UPLOADED",
    module: "FINANCE",
    description: `Uploaded reference document "${file.originalname}" to ${docs.length} Budget Allocation(s).`,
    entityType: "BudgetAllocation",
    entityId: docs[0]._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return docs.map((doc) => serialize(doc, maps));
}

/**
 * Every Budget Allocation the current user can act on right now as
 * Verifier or Checker — the Approvals page's data source for this module.
 * Super Admin sees every pending record; everyone else only sees the ones
 * targeting an Organization Node they actually hold that role on.
 */
export async function getMyPendingBudgetAllocations(actor: ActorForPermission): Promise<BudgetAllocationDto[]> {
  const [verifierNodes, checkerNodes] = await Promise.all([
    getMyActionableNodeIds(actor, "Verifier"),
    getMyActionableNodeIds(actor, "Checker"),
  ]);

  const orConditions: Record<string, unknown>[] = [];
  if (verifierNodes === "ALL") {
    orConditions.push({ approvalStatus: "PENDING_VERIFICATION" });
  } else if (verifierNodes.length > 0) {
    orConditions.push({ approvalStatus: "PENDING_VERIFICATION", organizationNodeId: { $in: verifierNodes } });
  }
  if (checkerNodes === "ALL") {
    orConditions.push({ approvalStatus: "PENDING_CHECKER_APPROVAL" });
  } else if (checkerNodes.length > 0) {
    orConditions.push({ approvalStatus: "PENDING_CHECKER_APPROVAL", organizationNodeId: { $in: checkerNodes } });
  }
  if (orConditions.length === 0) return [];

  const docs = await BudgetAllocationModel.find({ $or: orConditions }).sort({ createdAt: -1 });
  const maps = await buildLookupMaps();
  return docs.map((doc) => serialize(doc, maps));
}

export { serializeAggregatedRow as serializeBudgetAllocationRowForExport };
