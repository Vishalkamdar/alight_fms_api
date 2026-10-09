import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { FundTransferModel, type FundTransferDocument, type FundTransferType } from "../../models/fms/FundTransfer";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import { BudgetAllocationModel } from "../../models/fms/BudgetAllocation";
import { UserModel, type UserRole } from "../../models/User";
import { assertFinancialYearIsWritable } from "./financial-year.service";
import {
  isOrganizationNodeSelfOrDescendant,
  assertRootOrganizationNode,
  assertRootSchemeHeadNode,
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
import type { FmsRole } from "../../models/fms/FmsUserNodeRole";
import type {
  CreateFundTransferInput,
  FundTransferExportQuery,
  FundTransferListQuery,
} from "../../schemas/fms/fund-transfer.schema";

interface ActorContext {
  actorId: Types.ObjectId;
  actorRole: UserRole;
  ipAddress: string | null;
  userAgent?: string | null;
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

export interface FundTransferDto {
  _id: string;
  transactionType: FundTransferType;
  financialYearId: string;
  financialYear: FinancialYearRef | null;
  organizationRootNodeId: string;
  schemeHeadRootNodeId: string;
  headId: string | null;
  head: NodeRef | null;
  sourceNodeId: string;
  sourceNode: NodeRef | null;
  destinationNodeId: string;
  destinationNode: NodeRef | null;
  amount: number;
  reason: string;
  relatedBudgetAllocationId: string | null;
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
    orgNodeMap: new Map<string, NodeRef>(orgNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])),
    schemeHeadNodeMap: new Map<string, NodeRef>(
      schemeHeadNodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])
    ),
    financialYearMap: new Map<string, FinancialYearRef>(
      financialYears.map((y) => [String(y._id), { _id: String(y._id), financialYear: y.financialYear }])
    ),
    makerMap: new Map<string, UserRef>(makers.map((u) => [String(u._id), { _id: String(u._id), fullname: u.fullname }])),
  };
}

function serialize(doc: FundTransferDocument, maps: Awaited<ReturnType<typeof buildLookupMaps>>): FundTransferDto {
  const financialYearId = String(doc.financialYearId);
  const sourceNodeId = String(doc.sourceNodeId);
  const destinationNodeId = String(doc.destinationNodeId);
  const headId = doc.headId ? String(doc.headId) : null;
  const makerId = doc.makerId ? String(doc.makerId) : null;

  return {
    _id: String(doc._id),
    transactionType: doc.transactionType,
    financialYearId,
    financialYear: maps.financialYearMap.get(financialYearId) ?? null,
    organizationRootNodeId: String(doc.organizationRootNodeId),
    schemeHeadRootNodeId: String(doc.schemeHeadRootNodeId),
    headId,
    head: headId ? maps.schemeHeadNodeMap.get(headId) ?? null : null,
    sourceNodeId,
    sourceNode: maps.orgNodeMap.get(sourceNodeId) ?? null,
    destinationNodeId,
    destinationNode: maps.orgNodeMap.get(destinationNodeId) ?? null,
    amount: doc.amount,
    reason: doc.reason,
    relatedBudgetAllocationId: doc.relatedBudgetAllocationId ? String(doc.relatedBudgetAllocationId) : null,
    approvalStatus: doc.approvalStatus,
    workflowSnapshot: doc.workflowSnapshot,
    makerId,
    maker: makerId ? maps.makerMap.get(makerId) ?? null : null,
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
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The node whose Maker/Verifier/Checker configuration governs THIS
 * transaction's workflow — whichever side actually initiated it. A Pull is
 * initiated by the parent (destinationNodeId), a Return by the child
 * (sourceNodeId) — spec §7: "Apply the currently configured Approval Roles
 * for the applicable Organization Node," meaning the initiator's own node.
 */
function governingNodeId(doc: Pick<FundTransferDocument, "transactionType" | "sourceNodeId" | "destinationNodeId">): Types.ObjectId {
  return doc.transactionType === "PULL_FROM_CHILD" ? doc.destinationNodeId : doc.sourceNodeId;
}

/**
 * Verifies sourceNodeId and destinationNodeId are an actual immediate
 * parent/child pair in the real Organization Tree — never trusts these ids
 * as given, since a tampered request could otherwise name any two
 * unrelated nodes (§11).
 */
async function assertImmediateParentChild(sourceNodeId: string, destinationNodeId: string): Promise<void> {
  const source = await OrganizationNodeModel.findById(sourceNodeId).select("status parentNodeId");
  if (!source) {
    throw new AppError(422, "The source Organization Node does not exist.", {
      sourceNodeId: ["Organization Node not found."],
    });
  }
  if (source.status !== "Active") {
    throw new AppError(422, "The source Organization Node is inactive.", { sourceNodeId: ["Node must be active."] });
  }
  if (!source.parentNodeId || String(source.parentNodeId) !== String(destinationNodeId)) {
    throw new AppError(
      422,
      "The destination Organization Node must be the source node's immediate parent.",
      { destinationNodeId: ["Transfers are only allowed between an immediate parent and child node."] }
    );
  }
  const destination = await OrganizationNodeModel.findById(destinationNodeId).select("status");
  if (!destination || destination.status !== "Active") {
    throw new AppError(422, "The destination Organization Node is inactive or does not exist.", {
      destinationNodeId: ["Node must be active."],
    });
  }
}

interface ResolvedTransferScope {
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
}

async function resolveTransferScope(input: CreateFundTransferInput): Promise<ResolvedTransferScope> {
  await assertFinancialYearIsWritable(input.financialYearId);
  await assertRootOrganizationNode(input.organizationRootNodeId);
  await assertRootSchemeHeadNode(input.schemeHeadRootNodeId);

  for (const [key, nodeId] of [
    ["sourceNodeId", input.sourceNodeId],
    ["destinationNodeId", input.destinationNodeId],
  ] as const) {
    const inScope = await isOrganizationNodeSelfOrDescendant(nodeId, input.organizationRootNodeId);
    if (!inScope) {
      throw new AppError(422, "The selected Organization Node does not belong to this scope's hierarchy.", {
        [key]: ["Node must be under the selected root Organization Node."],
      });
    }
  }

  if (input.headId) {
    const headNode = await SchemeHeadNodeModel.findById(input.headId);
    if (!headNode || headNode.status !== "Active") {
      throw new AppError(422, "The selected Head does not exist or is inactive.", { headId: ["Head must be active."] });
    }
  }

  return {
    financialYearId: new Types.ObjectId(input.financialYearId),
    organizationRootNodeId: new Types.ObjectId(input.organizationRootNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(input.schemeHeadRootNodeId),
  };
}

export interface ReturnableAmountBreakdown {
  /** Everything this node has ever actually received (APPROVED only) — every receipt's own face amount, untouched. */
  totalReceivedAmount: number;
  /**
   * Already spoken for out of that total — sub-allocated onward to this
   * node's own children, OR already committed to another pull/return
   * (pending verification/approval counts too, the same "Holding is
   * reserved the instant it's submitted" rule as everywhere else in this
   * app — see BudgetAllocation's own holdingAmount semantics).
   */
  onHoldAmount: number;
  /** totalReceivedAmount - onHoldAmount — what's actually free to pull/return right now. */
  returnableAmount: number;
}

/**
 * Read-only "how much can actually be pulled/returned right now," broken
 * down so the figure is self-evidently correct rather than one opaque
 * number — a node can easily have received money across MORE THAN ONE
 * receipt (e.g. two separate Budget Allocations over time), so "already
 * has a pending return for X" and "still shows some amount available" are
 * NOT a contradiction unless X equals the node's entire total. Sums, across
 * every one of this node's own received pools (its APPROVED Budget
 * Allocation receipts and any APPROVED Fund Transfers pulled/returned INTO
 * it), that pool's own face amount and its own remaining headroom. The
 * returnable figure matches exactly what the atomic reservation in
 * createFundTransfer would allow — this whole function is purely the
 * informational/pre-check the frontend displays before submit; the
 * authoritative check happens again, atomically, at creation time.
 */
export async function getReturnableAmount(
  nodeId: string,
  scope: { financialYearId: string; organizationRootNodeId: string; schemeHeadRootNodeId: string }
): Promise<ReturnableAmountBreakdown> {
  const matchBase = {
    financialYearId: new Types.ObjectId(scope.financialYearId),
    organizationRootNodeId: new Types.ObjectId(scope.organizationRootNodeId),
    schemeHeadRootNodeId: new Types.ObjectId(scope.schemeHeadRootNodeId),
    approvalStatus: "APPROVED" as const,
  };
  const [allocations, transfers] = await Promise.all([
    BudgetAllocationModel.find({ ...matchBase, organizationNodeId: nodeId }).select("amount subAllocatedAmount"),
    FundTransferModel.find({ ...matchBase, destinationNodeId: nodeId }).select("amount subAllocatedAmount"),
  ]);
  const allDocs = [...allocations, ...transfers];
  const totalReceivedAmount = allDocs.reduce((sum, d) => sum + d.amount, 0);
  const returnableAmount = allDocs.reduce((sum, d) => sum + Math.max(0, d.amount - d.subAllocatedAmount), 0);
  return {
    totalReceivedAmount,
    onHoldAmount: totalReceivedAmount - returnableAmount,
    returnableAmount,
  };
}

async function assertInitiatorPermission(
  transactionType: FundTransferType,
  actor: ActorForPermission,
  input: CreateFundTransferInput
): Promise<void> {
  const initiatingNodeId = transactionType === "PULL_FROM_CHILD" ? input.destinationNodeId : input.sourceNodeId;
  await assertMakerPermission(actor, initiatingNodeId);
}

/**
 * Shared creation path for both modules — only `transactionType` and which
 * side the Maker permission check runs against differ between Pull and
 * Return (see the two thin exported wrappers below). Reserves the amount
 * atomically from the source node's own received pool (the SAME shared
 * capacity counter sub-allocation draws from — see
 * reserveFromNodeOwnReceivedPool in budget-allocation.service.ts), so a
 * node's total outgoing commitments, whichever direction, can never
 * jointly exceed what it actually received. Never touches or rewrites the
 * original Budget Allocation record — this is always a new, separate
 * ledger entry.
 */
async function createFundTransfer(
  transactionType: FundTransferType,
  input: CreateFundTransferInput,
  context: ActorContext
): Promise<FundTransferDto> {
  const scope = await resolveTransferScope(input);
  await assertImmediateParentChild(input.sourceNodeId, input.destinationNodeId);
  await assertInitiatorPermission(transactionType, context, input);

  const initiatingNodeId = transactionType === "PULL_FROM_CHILD" ? input.destinationNodeId : input.sourceNodeId;
  const workflow = await resolveWorkflowForNode(initiatingNodeId);
  const autoApproved = workflow.initialStatus === "APPROVED";

  const session = await mongoose.startSession();
  let created: FundTransferDocument;
  let sourcePools: ReceivedPoolReservation[];
  try {
    const result = await session.withTransaction(async () => {
      const pools = await reserveFromNodeOwnReceivedPool(input.sourceNodeId, input.amount, scope, session);
      const [doc] = await FundTransferModel.create(
        [
          {
            transactionType,
            financialYearId: scope.financialYearId,
            organizationRootNodeId: scope.organizationRootNodeId,
            schemeHeadRootNodeId: scope.schemeHeadRootNodeId,
            headId: input.headId ?? null,
            sourceNodeId: input.sourceNodeId,
            destinationNodeId: input.destinationNodeId,
            amount: input.amount,
            reason: input.reason,
            relatedBudgetAllocationId: input.relatedBudgetAllocationId ?? null,
            sourcePools: pools,
            approvalStatus: workflow.initialStatus,
            workflowSnapshot: workflow.snapshot,
            makerId: context.actorId,
            holdingAmount: autoApproved ? 0 : input.amount,
            approvedAmount: autoApproved ? input.amount : 0,
            transferredAmount: autoApproved ? input.amount : 0,
            approvedAt: autoApproved ? new Date() : null,
            createdBy: context.actorId,
            updatedBy: context.actorId,
          },
        ],
        { session }
      );

      await recordWorkflowEvent(
        { module: "FUND_TRANSFER", recordId: doc._id, organizationNodeId: doc.sourceNodeId, amount: doc.amount },
        {
          action: "MAKER_SUBMITTED",
          userId: context.actorId,
          userRole: "Maker",
          previousStatus: null,
          newStatus: doc.approvalStatus,
          holdingAmount: doc.holdingAmount,
          remarks: input.reason,
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
    user: context.actorId,
    action: transactionType === "PULL_FROM_CHILD" ? "FUND_TRANSFER_PULL_CREATED" : "FUND_TRANSFER_RETURN_CREATED",
    module: "FINANCE",
    description: `${transactionType === "PULL_FROM_CHILD" ? "Pulled" : "Returned"} ${input.amount} between Organization Nodes ${input.sourceNodeId} -> ${input.destinationNodeId} — reason: ${input.reason} — drawn from ${sourcePools.length} pool(s), ${workflow.initialStatus}.`,
    entityType: "FundTransfer",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(created, maps);
}

export async function createPullTransfer(input: CreateFundTransferInput, context: ActorContext): Promise<FundTransferDto> {
  return createFundTransfer("PULL_FROM_CHILD", input, context);
}

export async function createReturnTransfer(input: CreateFundTransferInput, context: ActorContext): Promise<FundTransferDto> {
  return createFundTransfer("RETURN_TO_PARENT", input, context);
}

/** Escapes a string for safe use inside a RegExp constructor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SORT_FIELD_MAP: Record<string, string> = {
  createdAt: "createdAt",
  amount: "amount",
  sourceNode: "sourceNode.name",
  destinationNode: "destinationNode.name",
  financialYear: "financialYear.financialYear",
  maker: "maker.fullname",
};

interface AggregatedFundTransferRow {
  _id: Types.ObjectId;
  transactionType: FundTransferType;
  financialYearId: Types.ObjectId;
  financialYear: { _id: Types.ObjectId; financialYear: string } | null;
  organizationRootNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  headId: Types.ObjectId | null;
  head: { _id: Types.ObjectId; name: string } | null;
  sourceNodeId: Types.ObjectId;
  sourceNode: { _id: Types.ObjectId; name: string } | null;
  destinationNodeId: Types.ObjectId;
  destinationNode: { _id: Types.ObjectId; name: string } | null;
  amount: number;
  reason: string;
  relatedBudgetAllocationId: Types.ObjectId | null;
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
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeAggregatedRow(row: AggregatedFundTransferRow): FundTransferDto {
  const financialYearId = String(row.financialYearId);
  const headId = row.headId ? String(row.headId) : null;
  const makerId = row.makerId ? String(row.makerId) : null;
  return {
    _id: String(row._id),
    transactionType: row.transactionType,
    financialYearId,
    financialYear: row.financialYear
      ? { _id: String(row.financialYear._id), financialYear: row.financialYear.financialYear }
      : null,
    organizationRootNodeId: String(row.organizationRootNodeId),
    schemeHeadRootNodeId: String(row.schemeHeadRootNodeId),
    headId,
    head: row.head ? { _id: String(row.head._id), name: row.head.name } : null,
    sourceNodeId: String(row.sourceNodeId),
    sourceNode: row.sourceNode ? { _id: String(row.sourceNode._id), name: row.sourceNode.name } : null,
    destinationNodeId: String(row.destinationNodeId),
    destinationNode: row.destinationNode ? { _id: String(row.destinationNode._id), name: row.destinationNode.name } : null,
    amount: row.amount,
    reason: row.reason,
    relatedBudgetAllocationId: row.relatedBudgetAllocationId ? String(row.relatedBudgetAllocationId) : null,
    approvalStatus: row.approvalStatus,
    workflowSnapshot: row.workflowSnapshot,
    makerId,
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
    createdBy: row.createdBy ? String(row.createdBy) : null,
    updatedBy: row.updatedBy ? String(row.updatedBy) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Scopes a list/export query to the nodes this actor is allowed to see,
 * per the module's own direction — a Pull list is scoped by the viewer's
 * Maker access to destinationNodeId (the parent side); a Return list by
 * their Maker access to sourceNodeId (the child side). `null` means
 * unrestricted (Super Admin/Admin).
 */
function buildFundTransfersPipeline(
  query: FundTransferListQuery | FundTransferExportQuery,
  allowedNodeIds: string[] | null
): mongoose.PipelineStage[] {
  const match: Record<string, unknown> = {};
  if (query.transactionType) match.transactionType = query.transactionType;
  if (query.financialYearId) match.financialYearId = new Types.ObjectId(query.financialYearId);
  if (query.organizationRootNodeId) match.organizationRootNodeId = new Types.ObjectId(query.organizationRootNodeId);
  if (query.schemeHeadRootNodeId) match.schemeHeadRootNodeId = new Types.ObjectId(query.schemeHeadRootNodeId);
  if (query.sourceNodeId) match.sourceNodeId = new Types.ObjectId(query.sourceNodeId);
  if (query.destinationNodeId) match.destinationNodeId = new Types.ObjectId(query.destinationNodeId);
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

  if (allowedNodeIds) {
    const allowedObjectIds = allowedNodeIds.map((id) => new Types.ObjectId(id));
    const sideField = query.transactionType === "RETURN_TO_PARENT" ? "sourceNodeId" : "destinationNodeId";
    const existing = match[sideField];
    match[sideField] = existing ? { $eq: existing, $in: allowedObjectIds } : { $in: allowedObjectIds };
  }

  const pipeline: mongoose.PipelineStage[] = [
    { $match: match },
    { $lookup: { from: "organizationnodes", localField: "sourceNodeId", foreignField: "_id", as: "sourceNode" } },
    { $unwind: { path: "$sourceNode", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "organizationnodes", localField: "destinationNodeId", foreignField: "_id", as: "destinationNode" } },
    { $unwind: { path: "$destinationNode", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "schemeheadnodes", localField: "headId", foreignField: "_id", as: "head" } },
    { $unwind: { path: "$head", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "financialyears", localField: "financialYearId", foreignField: "_id", as: "financialYear" } },
    { $unwind: { path: "$financialYear", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        let: { makerId: "$makerId" },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$makerId"] } } }, { $project: { fullname: 1 } }],
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
          { reason: regex },
          { "sourceNode.name": regex },
          { "destinationNode.name": regex },
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

export async function listFundTransfers(
  query: FundTransferListQuery,
  allowedNodeIds: string[] | null
): Promise<ListResult<FundTransferDto>> {
  const pipeline = buildFundTransfersPipeline(query, allowedNodeIds);
  const [result] = await FundTransferModel.aggregate([
    ...pipeline,
    { $facet: { items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], totalCount: [{ $count: "count" }] } },
  ]);
  const total: number = result.totalCount[0]?.count ?? 0;
  return {
    items: (result.items as AggregatedFundTransferRow[]).map(serializeAggregatedRow),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getFundTransfersCursorForExport(query: FundTransferExportQuery, allowedNodeIds: string[] | null) {
  return FundTransferModel.aggregate<AggregatedFundTransferRow>(buildFundTransfersPipeline(query, allowedNodeIds)).cursor();
}

/** A module's own list page — Maker's view, scoped to their own assigned/inherited nodes on the relevant side. `null` for Super Admin/Admin. */
export async function getAllowedNodeIdsForTransferModule(actor: ActorForPermission): Promise<string[] | null> {
  return getAllowedNodeIdsForList(actor);
}

export async function getFundTransferById(id: string, allowedNodeIds?: string[] | null): Promise<FundTransferDto> {
  const doc = await FundTransferModel.findById(id);
  if (!doc) throw new AppError(404, "Fund Transfer not found.");
  if (allowedNodeIds) {
    const relevantNodeId = doc.transactionType === "RETURN_TO_PARENT" ? String(doc.sourceNodeId) : String(doc.destinationNodeId);
    if (!allowedNodeIds.includes(relevantNodeId)) throw new AppError(404, "Fund Transfer not found.");
  }
  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function verifyFundTransfer(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<FundTransferDto> {
  const doc = await FundTransferModel.findById(id);
  if (!doc) throw new AppError(404, "Fund Transfer not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION") {
    throw new AppError(422, "This Fund Transfer is not pending verification.");
  }
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    context.actorId
  );
  await assertVerifierPermission(context, String(governingNodeId(doc)));

  const { nextStatus, isFinal } = computeVerifyTransition(doc.workflowSnapshot);
  const previousStatus = doc.approvalStatus;

  doc.verifierId = context.actorId;
  doc.verifiedAt = new Date();
  doc.approvalStatus = nextStatus;
  if (isFinal) {
    doc.holdingAmount = 0;
    doc.approvedAmount = doc.amount;
    doc.transferredAmount = doc.amount;
    doc.approvedAt = new Date();
  }
  doc.updatedBy = context.actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "FUND_TRANSFER", recordId: doc._id, organizationNodeId: doc.sourceNodeId, amount: doc.amount },
        {
          action: "VERIFIER_VERIFIED",
          userId: context.actorId,
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
    user: context.actorId,
    action: "FUND_TRANSFER_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified Fund Transfer ${String(doc._id)}${isFinal ? " — final approval, funds transferred." : "."}`,
    entityType: "FundTransfer",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function approveFundTransfer(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<FundTransferDto> {
  const doc = await FundTransferModel.findById(id);
  if (!doc) throw new AppError(404, "Fund Transfer not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Fund Transfer is not pending Checker approval.");
  }
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    context.actorId
  );
  await assertCheckerPermission(context, String(governingNodeId(doc)));

  const previousStatus = doc.approvalStatus;
  doc.checkerId = context.actorId;
  doc.approvalStatus = "APPROVED";
  doc.holdingAmount = 0;
  doc.approvedAmount = doc.amount;
  doc.transferredAmount = doc.amount;
  doc.approvedAt = new Date();
  doc.updatedBy = context.actorId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await doc.save({ session });
      await recordWorkflowEvent(
        { module: "FUND_TRANSFER", recordId: doc._id, organizationNodeId: doc.sourceNodeId, amount: doc.amount },
        {
          action: "CHECKER_APPROVED",
          userId: context.actorId,
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
    user: context.actorId,
    action: "FUND_TRANSFER_APPROVED",
    module: "FINANCE",
    description: `Checker approved Fund Transfer ${String(doc._id)} — funds transferred.`,
    entityType: "FundTransfer",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function rejectFundTransfer(
  id: string,
  input: { reason: string },
  context: ActorContext
): Promise<FundTransferDto> {
  const doc = await FundTransferModel.findById(id);
  if (!doc) throw new AppError(404, "Fund Transfer not found.");
  await assertFinancialYearIsWritable(doc.financialYearId);
  if (doc.approvalStatus !== "PENDING_VERIFICATION" && doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Fund Transfer is not pending any approval.");
  }
  assertNotSelfApproving(
    { makerId: doc.makerId ?? new Types.ObjectId(), verifierId: doc.verifierId, checkerId: doc.checkerId, workflowSnapshot: doc.workflowSnapshot },
    context.actorId
  );

  const isVerifierStage = doc.approvalStatus === "PENDING_VERIFICATION";
  if (isVerifierStage) {
    await assertVerifierPermission(context, String(governingNodeId(doc)));
  } else {
    await assertCheckerPermission(context, String(governingNodeId(doc)));
  }

  const previousStatus = doc.approvalStatus;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await releaseToParentPool(doc.sourcePools, session);

      doc.approvalStatus = isVerifierStage ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
      doc.rejectionReason = input.reason;
      doc.rejectedBy = context.actorId;
      doc.rejectedAt = new Date();
      doc.holdingAmount = 0;
      if (isVerifierStage) doc.verifierId = context.actorId;
      else doc.checkerId = context.actorId;
      doc.updatedBy = context.actorId;
      await doc.save({ session });

      await recordWorkflowEvent(
        { module: "FUND_TRANSFER", recordId: doc._id, organizationNodeId: doc.sourceNodeId, amount: doc.amount },
        {
          action: isVerifierStage ? "VERIFIER_REJECTED" : "CHECKER_REJECTED",
          userId: context.actorId,
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
    user: context.actorId,
    action: isVerifierStage ? "FUND_TRANSFER_REJECTED_BY_VERIFIER" : "FUND_TRANSFER_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected Fund Transfer ${String(doc._id)}: ${input.reason} — Holding released.`,
    entityType: "FundTransfer",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export interface BulkFundTransferResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
}

async function processBulkAction(ids: string[], action: (id: string) => Promise<unknown>): Promise<BulkFundTransferResult> {
  const result: BulkFundTransferResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      await action(id);
      result.succeeded.push(id);
    } catch (error) {
      result.failed.push({ id, reason: error instanceof AppError ? error.message : "Failed to process this transaction." });
    }
  }
  return result;
}

export async function bulkVerifyFundTransfers(
  ids: string[],
  input: { remarks?: string },
  context: ActorContext
): Promise<BulkFundTransferResult> {
  return processBulkAction(ids, (id) => verifyFundTransfer(id, input, context));
}

export async function bulkApproveFundTransfers(
  ids: string[],
  input: { remarks?: string },
  context: ActorContext
): Promise<BulkFundTransferResult> {
  return processBulkAction(ids, (id) => approveFundTransfer(id, input, context));
}

/**
 * The approval-queue node filter for a given stage — a Pull row is
 * actionable if the viewer holds `stage` on its destinationNodeId (the
 * initiator); a Return row, on its sourceNodeId. Both checks reuse the
 * SAME actionable-node set (role-based, not type-based, exactly like every
 * other financial module's Verifier/Checker scoping).
 */
async function stageMatchCondition(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  forcedStatus: ApprovalStatus
): Promise<Record<string, unknown> | null> {
  const actionableNodeIds = await getMyActionableNodeIds(actor, stage);
  if (actionableNodeIds === "ALL") {
    return { approvalStatus: forcedStatus };
  }
  if (actionableNodeIds.length === 0) return null;
  const ids = actionableNodeIds.map((id) => new Types.ObjectId(id));
  return {
    approvalStatus: forcedStatus,
    $or: [
      { transactionType: "PULL_FROM_CHILD", destinationNodeId: { $in: ids } },
      { transactionType: "RETURN_TO_PARENT", sourceNodeId: { $in: ids } },
    ],
  };
}

export async function listPendingApprovalsForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: FundTransferListQuery
): Promise<ListResult<FundTransferDto>> {
  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  const condition = await stageMatchCondition(stage, actor, forcedStatus);
  if (!condition) return { items: [], meta: { page: query.page, limit: query.limit, total: 0, totalPages: 1 } };

  const pipeline: mongoose.PipelineStage[] = [{ $match: condition }];
  const basePipeline = buildFundTransfersPipeline({ ...query, approvalStatus: forcedStatus }, null);
  // Drop basePipeline's own leading $match (already folded into `condition`
  // above, which additionally carries the stage's $or) — keep every lookup/
  // search/sort stage that follows it.
  const [, ...rest] = basePipeline;
  pipeline.push(...rest);

  const [result] = await FundTransferModel.aggregate([
    ...pipeline,
    { $facet: { items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], totalCount: [{ $count: "count" }] } },
  ]);
  const total: number = result.totalCount[0]?.count ?? 0;
  return {
    items: (result.items as AggregatedFundTransferRow[]).map(serializeAggregatedRow),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export async function getPendingApprovalsCursorForStage(
  stage: Extract<FmsRole, "Verifier" | "Checker">,
  actor: ActorForPermission,
  query: FundTransferExportQuery
) {
  const forcedStatus: ApprovalStatus = stage === "Verifier" ? "PENDING_VERIFICATION" : "PENDING_CHECKER_APPROVAL";
  const condition = await stageMatchCondition(stage, actor, forcedStatus);
  if (!condition) return null;

  const pipeline: mongoose.PipelineStage[] = [{ $match: condition }];
  const basePipeline = buildFundTransfersPipeline({ ...query, approvalStatus: forcedStatus }, null);
  const [, ...rest] = basePipeline;
  pipeline.push(...rest);
  return FundTransferModel.aggregate<AggregatedFundTransferRow>(pipeline).cursor();
}

/** Every Fund Transfer the current user can act on right now as Verifier or Checker — for the shared Approvals page. */
export async function getMyPendingFundTransfers(actor: ActorForPermission): Promise<FundTransferDto[]> {
  const [verifierCondition, checkerCondition] = await Promise.all([
    stageMatchCondition("Verifier", actor, "PENDING_VERIFICATION"),
    stageMatchCondition("Checker", actor, "PENDING_CHECKER_APPROVAL"),
  ]);
  const orConditions = [verifierCondition, checkerCondition].filter((c): c is Record<string, unknown> => c !== null);
  if (orConditions.length === 0) return [];

  const docs = await FundTransferModel.find({ $or: orConditions }).sort({ createdAt: -1 });
  const maps = await buildLookupMaps();
  return docs.map((doc) => serialize(doc, maps));
}

export { serializeAggregatedRow as serializeFundTransferRowForExport };
