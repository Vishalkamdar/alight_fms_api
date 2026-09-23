import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { UPLOAD_ROOT_DIR } from "../../utils/fms/upload";
import { BudgetSetupModel, type BudgetSetupDocument, type FmsStatus } from "../../models/fms/BudgetSetup";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import {
  assertFinancialYearIsWritable,
  resolveFinancialYearForNewEntry,
} from "./financial-year.service";
import {
  assertMakerPermission,
  assertVerifierPermission,
  assertCheckerPermission,
  assertNotSelfApproving,
  computeVerifyTransition,
  resolveWorkflowForNode,
  recordWorkflowEvent,
  getMyActionableNodeIds,
  type ApprovalStatus,
  type WorkflowSnapshot,
  type ActorForPermission,
} from "./financial-workflow.service";
import type { UserRole } from "../../models/User";
import type {
  BudgetSetupExportQuery,
  BudgetSetupListQuery,
  CreateBudgetSetupInput,
  UpdateBudgetSetupInput,
} from "../../schemas/fms/budget-setup.schema";

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

export interface BudgetSetupAttachmentDto {
  _id: string;
  originalName: string;
  fileUrl: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: Date;
}

export interface BudgetSetupDto {
  _id: string;
  financialYearId: string;
  financialYear: FinancialYearRef | null;
  organizationNodeId: string;
  organizationNode: NodeRef | null;
  schemeHeadNodeId: string;
  schemeHeadNode: NodeRef | null;
  originalAmount: number;
  allocatedAmount: number;
  remainingAmount: number;
  remarks: string | null;
  attachments: BudgetSetupAttachmentDto[];
  status: FmsStatus;
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: string | null;
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
  const [orgNodes, schemeHeadNodes, financialYears] = await Promise.all([
    OrganizationNodeModel.find().select("name").lean(),
    SchemeHeadNodeModel.find().select("name").lean(),
    FinancialYearModel.find().select("financialYear").lean(),
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
  };
}

function serialize(
  doc: BudgetSetupDocument,
  maps: Awaited<ReturnType<typeof buildLookupMaps>>
): BudgetSetupDto {
  const financialYearId = String(doc.financialYearId);
  const organizationNodeId = String(doc.organizationNodeId);
  const schemeHeadNodeId = String(doc.schemeHeadNodeId);

  return {
    _id: String(doc._id),
    financialYearId,
    financialYear: maps.financialYearMap.get(financialYearId) ?? null,
    organizationNodeId,
    organizationNode: maps.orgNodeMap.get(organizationNodeId) ?? null,
    schemeHeadNodeId,
    schemeHeadNode: maps.schemeHeadNodeMap.get(schemeHeadNodeId) ?? null,
    originalAmount: doc.originalAmount,
    allocatedAmount: doc.allocatedAmount,
    remainingAmount: doc.originalAmount - doc.allocatedAmount,
    remarks: doc.remarks,
    attachments: doc.attachments.map((attachment) => ({
      _id: String(attachment._id),
      originalName: attachment.originalName,
      fileUrl: attachment.fileUrl,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadedBy: attachment.uploadedBy ? String(attachment.uploadedBy) : null,
      uploadedAt: attachment.uploadedAt,
    })),
    status: doc.status,
    approvalStatus: doc.approvalStatus,
    workflowSnapshot: doc.workflowSnapshot,
    makerId: doc.makerId ? String(doc.makerId) : null,
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

async function findByIdOr404(id: string): Promise<BudgetSetupDocument> {
  const doc = await BudgetSetupModel.findById(id);
  if (!doc) throw new AppError(404, "Budget Setup not found.");
  return doc;
}

/** Only ROOT-level nodes may anchor a Budget Setup (spec §1/§2) — active, and no parent. */
async function assertRootOrganizationNode(id: string): Promise<void> {
  const node = await OrganizationNodeModel.findById(id);
  if (!node) {
    throw new AppError(422, "The selected Organization Node does not exist.", {
      organizationNodeId: ["Organization Node not found."],
    });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "The selected Organization Node is inactive.", {
      organizationNodeId: ["Organization Node must be active."],
    });
  }
  if (node.parentNodeId) {
    throw new AppError(422, "Budget Setup must be anchored to a root-level Organization Node.", {
      organizationNodeId: ["Select a root-level (top of hierarchy) Organization Node."],
    });
  }
}

async function assertRootSchemeHeadNode(id: string): Promise<void> {
  const node = await SchemeHeadNodeModel.findById(id);
  if (!node) {
    throw new AppError(422, "The selected Scheme/Head Node does not exist.", {
      schemeHeadNodeId: ["Scheme/Head Node not found."],
    });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "The selected Scheme/Head Node is inactive.", {
      schemeHeadNodeId: ["Scheme/Head Node must be active."],
    });
  }
  if (node.parentNodeId) {
    throw new AppError(422, "Budget Setup must be anchored to a root-level Scheme/Head Node.", {
      schemeHeadNodeId: ["Select a root-level (top of hierarchy) Scheme/Head Node."],
    });
  }
}

/** Escapes a string for safe use inside a RegExp constructor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Public sortBy key -> actual aggregation field path. Kept as an explicit
 * allowlist (rather than trusting the query string directly) since it's
 * used as a dynamic $sort key — Zod already restricts sortBy to these exact
 * keys (see BUDGET_SETUP_SORT_KEYS), this is the second half of that map.
 */
const SORT_FIELD_MAP: Record<string, string> = {
  createdAt: "createdAt",
  financialYear: "financialYear.financialYear",
  organizationNode: "organizationNode.name",
  schemeHeadNode: "schemeHeadNode.name",
  originalAmount: "originalAmount",
  allocatedAmount: "allocatedAmount",
  remainingAmount: "remainingAmount",
  status: "status",
};

interface AggregatedBudgetSetupRow {
  _id: Types.ObjectId;
  financialYearId: Types.ObjectId;
  financialYear: { _id: Types.ObjectId; financialYear: string } | null;
  organizationNodeId: Types.ObjectId;
  organizationNode: { _id: Types.ObjectId; name: string } | null;
  schemeHeadNodeId: Types.ObjectId;
  schemeHeadNode: { _id: Types.ObjectId; name: string } | null;
  originalAmount: number;
  allocatedAmount: number;
  remainingAmount: number;
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
  status: FmsStatus;
  approvalStatus: ApprovalStatus;
  workflowSnapshot: WorkflowSnapshot;
  makerId: Types.ObjectId | null;
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

function serializeAggregatedRow(row: AggregatedBudgetSetupRow): BudgetSetupDto {
  return {
    _id: String(row._id),
    financialYearId: String(row.financialYearId),
    financialYear: row.financialYear
      ? { _id: String(row.financialYear._id), financialYear: row.financialYear.financialYear }
      : null,
    organizationNodeId: String(row.organizationNodeId),
    organizationNode: row.organizationNode
      ? { _id: String(row.organizationNode._id), name: row.organizationNode.name }
      : null,
    schemeHeadNodeId: String(row.schemeHeadNodeId),
    schemeHeadNode: row.schemeHeadNode
      ? { _id: String(row.schemeHeadNode._id), name: row.schemeHeadNode.name }
      : null,
    originalAmount: row.originalAmount,
    allocatedAmount: row.allocatedAmount,
    remainingAmount: row.remainingAmount,
    remarks: row.remarks,
    attachments: row.attachments.map((attachment) => ({
      _id: String(attachment._id),
      originalName: attachment.originalName,
      fileUrl: attachment.fileUrl,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadedBy: attachment.uploadedBy ? String(attachment.uploadedBy) : null,
      uploadedAt: attachment.uploadedAt,
    })),
    status: row.status,
    approvalStatus: row.approvalStatus,
    workflowSnapshot: row.workflowSnapshot,
    makerId: row.makerId ? String(row.makerId) : null,
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
 * Shared by listBudgetSetups (paginated) and the CSV export (unbounded
 * cursor) — filters + lookups + the computed remainingAmount + sort, with
 * no $skip/$limit/$facet so callers can add their own pagination or stream
 * every matching row. Sorting/searching by populated node names requires
 * the $lookup to run before $match/$sort, which is why this can't be a
 * plain find().sort() — Mongo can't sort or regex-match a field that only
 * exists on a referenced document without joining it in first.
 */
function buildBudgetSetupsPipeline(
  query: BudgetSetupListQuery | BudgetSetupExportQuery
): mongoose.PipelineStage[] {
  const match: Record<string, unknown> = {};
  if (query.financialYearId) match.financialYearId = new Types.ObjectId(query.financialYearId);
  if (query.organizationNodeId) match.organizationNodeId = new Types.ObjectId(query.organizationNodeId);
  if (query.schemeHeadNodeId) match.schemeHeadNodeId = new Types.ObjectId(query.schemeHeadNodeId);
  if (query.status) match.status = query.status;
  if (query.approvalStatus) match.approvalStatus = query.approvalStatus;

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
        localField: "schemeHeadNodeId",
        foreignField: "_id",
        as: "schemeHeadNode",
      },
    },
    { $unwind: { path: "$schemeHeadNode", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "financialyears",
        localField: "financialYearId",
        foreignField: "_id",
        as: "financialYear",
      },
    },
    { $unwind: { path: "$financialYear", preserveNullAndEmptyArrays: true } },
    { $addFields: { remainingAmount: { $subtract: ["$originalAmount", "$allocatedAmount"] } } },
  ];

  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), "i");
    pipeline.push({
      $match: {
        $or: [
          { remarks: regex },
          { "organizationNode.name": regex },
          { "schemeHeadNode.name": regex },
          { "financialYear.financialYear": regex },
        ],
      },
    });
  }

  const sortField = SORT_FIELD_MAP[query.sortBy] ?? "createdAt";
  pipeline.push({ $sort: { [sortField]: query.sortOrder === "asc" ? 1 : -1 } });

  return pipeline;
}

export async function listBudgetSetups(query: BudgetSetupListQuery): Promise<ListResult<BudgetSetupDto>> {
  const pipeline = buildBudgetSetupsPipeline(query);

  const [result] = await BudgetSetupModel.aggregate([
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
    items: (result.items as AggregatedBudgetSetupRow[]).map(serializeAggregatedRow),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

/**
 * Streams every matching row as a cursor (never materializes the full
 * result set in memory) for the CSV export — same filters/search/sort as
 * the list, just unbounded.
 */
export function getBudgetSetupsCursorForExport(query: BudgetSetupExportQuery) {
  const pipeline = buildBudgetSetupsPipeline(query);
  return BudgetSetupModel.aggregate<AggregatedBudgetSetupRow>(pipeline).cursor();
}

export { serializeAggregatedRow as serializeBudgetSetupRowForExport };

/**
 * Every Budget Setup the current user can act on right now as Verifier or
 * Checker — the Approvals page's data source for this module. Super Admin
 * sees every pending record; everyone else only sees the ones anchored to
 * an Organization Node they actually hold that role on (§3/§4/§12).
 */
export async function getMyPendingBudgetSetups(actor: ActorForPermission): Promise<BudgetSetupDto[]> {
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

  const docs = await BudgetSetupModel.find({ $or: orConditions }).sort({ createdAt: -1 });
  const maps = await buildLookupMaps();
  return docs.map((doc) => serialize(doc, maps));
}

export async function getBudgetSetupById(id: string): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

/** APPROVED-and-terminal only when Maker-only (no Verifier/Checker) — that's an immediate transfer, per spec Case 4. */
function isImmediateApproval(status: ApprovalStatus): boolean {
  return status === "APPROVED";
}

export async function createBudgetSetup(
  input: CreateBudgetSetupInput,
  context: ActorContext
): Promise<BudgetSetupDto> {
  const financialYearId = input.financialYearId ?? String(await resolveFinancialYearForNewEntry());
  await assertFinancialYearIsWritable(financialYearId);
  await assertRootOrganizationNode(input.organizationNodeId);
  await assertRootSchemeHeadNode(input.schemeHeadNodeId);
  // Deliberately no duplicate-scope guard — multiple Budget Setups (e.g. an
  // initial sanction plus later top-up tranches) are allowed for the same
  // (Financial Year, root Organization Node, root Scheme/Head Node); Budget
  // Allocation pools them together (see reserveFromScope in
  // budget-allocation.service.ts) rather than treating each as an isolated,
  // mutually-exclusive fund.

  // GLOBAL FINANCIAL APPROVAL WORKFLOW §2/§7 — only an authorized Maker for
  // this Organization Node may create a Budget Setup; the applicable
  // workflow is resolved from that same node's Maker/Verifier/Checker
  // configuration and snapshotted onto the record so a later config change
  // can never reinterpret it (spec §20).
  const actorId = requireActorId(context);
  await assertMakerPermission({ actorId, actorRole: requireActorRole(context) }, input.organizationNodeId);
  const workflow = await resolveWorkflowForNode(input.organizationNodeId);
  const autoApproved = isImmediateApproval(workflow.initialStatus);

  const created = await BudgetSetupModel.create({
    financialYearId,
    organizationNodeId: input.organizationNodeId,
    schemeHeadNodeId: input.schemeHeadNodeId,
    originalAmount: input.originalAmount,
    remarks: input.remarks ?? null,
    approvalStatus: workflow.initialStatus,
    workflowSnapshot: workflow.snapshot,
    makerId: actorId,
    holdingAmount: autoApproved ? 0 : input.originalAmount,
    approvedAmount: autoApproved ? input.originalAmount : 0,
    transferredAmount: autoApproved ? input.originalAmount : 0,
    approvedAt: autoApproved ? new Date() : null,
    createdBy: actorId,
    updatedBy: actorId,
  });

  await recordWorkflowEvent(
    {
      module: "BUDGET_SETUP",
      recordId: created._id,
      organizationNodeId: created.organizationNodeId,
      amount: created.originalAmount,
    },
    {
      action: "MAKER_SUBMITTED",
      userId: actorId,
      userRole: "Maker",
      previousStatus: null,
      newStatus: workflow.initialStatus,
      holdingAmount: created.holdingAmount,
      ipAddress: context.ipAddress,
    }
  );

  await logActivity({
    user: actorId,
    action: "BUDGET_SETUP_CREATED",
    module: "FINANCE",
    description: `Maker created Budget Setup of ${input.originalAmount} for Financial Year ${financialYearId} — ${workflow.initialStatus}.`,
    entityType: "BudgetSetup",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(created, maps);
}

export async function updateBudgetSetup(
  id: string,
  input: UpdateBudgetSetupInput,
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  await assertFinancialYearIsWritable(doc.financialYearId);

  // §10 EDIT RULE — editable while the Maker/first stage still owns it:
  // before Verifier action (verifiedAt is null) and never once terminal
  // (APPROVED, or rejected-but-not-yet-corrected keeps its own separate
  // resubmit path below). Case 2 (Maker+Checker, no Verifier) stays
  // editable all the way through PENDING_CHECKER_APPROVAL since
  // verifiedAt is never set in that configuration.
  const isRejected = doc.approvalStatus === "REJECTED_BY_VERIFIER" || doc.approvalStatus === "REJECTED_BY_CHECKER";
  if (doc.approvalStatus === "APPROVED") {
    throw new AppError(422, "This Budget Setup has been approved and its amount is locked.", {
      originalAmount: ["Approved amounts cannot be modified."],
    });
  }
  if (!isRejected && doc.verifiedAt !== null) {
    throw new AppError(422, "This Budget Setup has already been verified and its amount is locked.", {
      originalAmount: ["Verified amounts cannot be modified before Checker action."],
    });
  }

  const previousStatus = doc.approvalStatus;

  if (input.originalAmount !== undefined) {
    if (input.originalAmount < doc.allocatedAmount) {
      throw new AppError(
        422,
        `Original amount cannot be reduced below the amount already allocated (${doc.allocatedAmount}).`,
        { originalAmount: ["Cannot be less than the amount already allocated."] }
      );
    }
    doc.originalAmount = input.originalAmount;
  }
  if (input.remarks !== undefined) doc.remarks = input.remarks;

  // §10 — correcting a rejected Budget Setup resubmits it: clear the
  // rejection and re-enter the workflow from the top, re-resolved against
  // the node's CURRENT configuration (this is a fresh Maker submission,
  // not a continuation of the old one, so re-snapshotting is correct here
  // unlike §20's "never reinterpret an existing record" rule, which is
  // about a config change silently altering an in-flight record).
  let resubmitted = false;
  if (isRejected) {
    const workflow = await resolveWorkflowForNode(String(doc.organizationNodeId));
    const autoApproved = isImmediateApproval(workflow.initialStatus);
    doc.approvalStatus = workflow.initialStatus;
    doc.workflowSnapshot = workflow.snapshot;
    doc.rejectionReason = null;
    doc.rejectedBy = null;
    doc.rejectedAt = null;
    doc.verifierId = null;
    doc.checkerId = null;
    doc.verifiedAt = null;
    doc.holdingAmount = autoApproved ? 0 : doc.originalAmount;
    doc.approvedAmount = autoApproved ? doc.originalAmount : 0;
    doc.transferredAmount = autoApproved ? doc.originalAmount : 0;
    doc.approvedAt = autoApproved ? new Date() : null;
    resubmitted = true;
  } else if (doc.holdingAmount > 0) {
    // Still pending (not yet approved) — keep the Holding figure in sync
    // with whatever the Maker just corrected the amount to.
    doc.holdingAmount = doc.originalAmount;
  }

  doc.updatedBy = context.actorId;
  await doc.save();

  if (resubmitted) {
    await recordWorkflowEvent(
      { module: "BUDGET_SETUP", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.originalAmount },
      {
        action: "MAKER_RESUBMITTED",
        userId: context.actorId,
        userRole: "Maker",
        previousStatus,
        newStatus: doc.approvalStatus,
        holdingAmount: doc.holdingAmount,
        ipAddress: context.ipAddress,
      }
    );
  }

  await logActivity({
    user: context.actorId,
    action: "BUDGET_SETUP_UPDATED",
    module: "FINANCE",
    description: `Updated Budget Setup ${String(doc._id)}.`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function verifyBudgetSetup(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  if (doc.approvalStatus !== "PENDING_VERIFICATION") {
    throw new AppError(422, "This Budget Setup is not pending verification.");
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
    doc.approvedAmount = doc.originalAmount;
    doc.transferredAmount = doc.originalAmount;
    doc.approvedAt = new Date();
  }
  doc.updatedBy = actorId;
  await doc.save();

  await recordWorkflowEvent(
    { module: "BUDGET_SETUP", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.originalAmount },
    {
      action: "VERIFIER_VERIFIED",
      userId: actorId,
      userRole: "Verifier",
      previousStatus,
      newStatus: nextStatus,
      holdingAmount: doc.holdingAmount,
      remarks: input.remarks,
      ipAddress: context.ipAddress,
    }
  );

  await logActivity({
    user: actorId,
    action: "BUDGET_SETUP_VERIFIED",
    module: "FINANCE",
    description: `Verifier verified Budget Setup ${String(doc._id)}${isFinal ? " — final approval, funds transferred." : "."}`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function approveBudgetSetup(
  id: string,
  input: { remarks?: string },
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  if (doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Budget Setup is not pending Checker approval.");
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
  doc.approvedAmount = doc.originalAmount;
  doc.transferredAmount = doc.originalAmount;
  doc.approvedAt = new Date();
  doc.updatedBy = actorId;
  await doc.save();

  await recordWorkflowEvent(
    { module: "BUDGET_SETUP", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.originalAmount },
    {
      action: "CHECKER_APPROVED",
      userId: actorId,
      userRole: "Checker",
      previousStatus,
      newStatus: "APPROVED",
      holdingAmount: 0,
      remarks: input.remarks,
      ipAddress: context.ipAddress,
    }
  );

  await logActivity({
    user: actorId,
    action: "BUDGET_SETUP_APPROVED",
    module: "FINANCE",
    description: `Checker approved Budget Setup ${String(doc._id)} — funds transferred.`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function rejectBudgetSetup(
  id: string,
  input: { reason: string },
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  if (doc.approvalStatus !== "PENDING_VERIFICATION" && doc.approvalStatus !== "PENDING_CHECKER_APPROVAL") {
    throw new AppError(422, "This Budget Setup is not pending any approval.");
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
  doc.approvalStatus = isVerifierStage ? "REJECTED_BY_VERIFIER" : "REJECTED_BY_CHECKER";
  doc.rejectionReason = input.reason;
  doc.rejectedBy = actorId;
  doc.rejectedAt = new Date();
  // No pool to release from — a Budget Setup is the top of the money
  // chain, not a draw against something else. Rejecting it simply means
  // its originalAmount never becomes real money (it was already excluded
  // from Budget Allocation's poolable funds while non-APPROVED).
  doc.holdingAmount = 0;
  if (isVerifierStage) doc.verifierId = actorId;
  else doc.checkerId = actorId;
  doc.updatedBy = actorId;
  await doc.save();

  await recordWorkflowEvent(
    { module: "BUDGET_SETUP", recordId: doc._id, organizationNodeId: doc.organizationNodeId, amount: doc.originalAmount },
    {
      action: isVerifierStage ? "VERIFIER_REJECTED" : "CHECKER_REJECTED",
      userId: actorId,
      userRole: isVerifierStage ? "Verifier" : "Checker",
      previousStatus,
      newStatus: doc.approvalStatus,
      holdingAmount: 0,
      remarks: input.reason,
      ipAddress: context.ipAddress,
    }
  );

  await logActivity({
    user: actorId,
    action: isVerifierStage ? "BUDGET_SETUP_REJECTED_BY_VERIFIER" : "BUDGET_SETUP_REJECTED_BY_CHECKER",
    module: "FINANCE",
    description: `${isVerifierStage ? "Verifier" : "Checker"} rejected Budget Setup ${String(doc._id)}: ${input.reason}`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function updateBudgetSetupStatus(
  id: string,
  status: FmsStatus,
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  doc.status = status;
  doc.updatedBy = context.actorId;
  await doc.save();

  await logActivity({
    user: context.actorId,
    action: status === "Active" ? "BUDGET_SETUP_ACTIVATED" : "BUDGET_SETUP_DEACTIVATED",
    module: "FINANCE",
    description: `Budget Setup ${String(doc._id)} set to ${status}.`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

// ---------------------------------------------------------------------------
// Allocation-facing API — what the future Budget Allocation module calls
// instead of reading/writing BudgetSetupModel directly (spec §4, §8, §9).
// ---------------------------------------------------------------------------

export interface AvailableBudgetDto {
  budgetSetupId: string;
  originalAmount: number;
  allocatedAmount: number;
  remainingAmount: number;
  status: FmsStatus;
}

/** "Original / Allocated / Remaining" display the Budget Allocation form must show (spec §4). */
export async function getAvailableBudget(budgetSetupId: string): Promise<AvailableBudgetDto> {
  const doc = await findByIdOr404(budgetSetupId);
  return {
    budgetSetupId: String(doc._id),
    originalAmount: doc.originalAmount,
    allocatedAmount: doc.allocatedAmount,
    remainingAmount: doc.originalAmount - doc.allocatedAmount,
    status: doc.status,
  };
}

/**
 * Atomically commits `amount` against a Budget Setup's remaining balance.
 * The remaining-budget check and the increment happen in a single
 * findOneAndUpdate so two concurrent allocation requests can never both
 * succeed past the same remaining balance (GLOBAL_RULES concurrency rule) —
 * a plain read-then-write would be a race condition here.
 */
export async function reserveBudgetAmount(
  budgetSetupId: string,
  amount: number,
  context: ActorContext
): Promise<AvailableBudgetDto> {
  if (amount <= 0) throw new AppError(400, "Amount to reserve must be greater than 0.");

  const updated = await BudgetSetupModel.findOneAndUpdate(
    {
      _id: budgetSetupId,
      status: "Active",
      $expr: { $lte: [{ $add: ["$allocatedAmount", amount] }, "$originalAmount"] },
    },
    { $inc: { allocatedAmount: amount }, $set: { updatedBy: context.actorId } },
    { returnDocument: "after" }
  );

  if (!updated) {
    const existing = await BudgetSetupModel.findById(budgetSetupId);
    if (!existing) throw new AppError(404, "Budget Setup not found.");
    if (existing.status !== "Active") throw new AppError(422, "This Budget Setup is inactive.");
    throw new AppError(409, "Requested amount exceeds the remaining budget.", {
      amount: [`Only ${existing.originalAmount - existing.allocatedAmount} remains available.`],
    });
  }

  await logActivity({
    user: context.actorId,
    action: "BUDGET_AMOUNT_RESERVED",
    module: "FINANCE",
    description: `Reserved ${amount} against Budget Setup ${budgetSetupId}.`,
    entityType: "BudgetSetup",
    entityId: updated._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return {
    budgetSetupId: String(updated._id),
    originalAmount: updated.originalAmount,
    allocatedAmount: updated.allocatedAmount,
    remainingAmount: updated.originalAmount - updated.allocatedAmount,
    status: updated.status,
  };
}

/** Reverses a prior reservation (allocation rejected/deleted) — floored at 0, never goes negative. */
export async function releaseBudgetAmount(
  budgetSetupId: string,
  amount: number,
  context: ActorContext
): Promise<AvailableBudgetDto> {
  if (amount <= 0) throw new AppError(400, "Amount to release must be greater than 0.");

  const updated = await BudgetSetupModel.findOneAndUpdate(
    { _id: budgetSetupId, $expr: { $gte: ["$allocatedAmount", amount] } },
    { $inc: { allocatedAmount: -amount }, $set: { updatedBy: context.actorId } },
    { returnDocument: "after" }
  );

  if (!updated) {
    const existing = await findByIdOr404(budgetSetupId);
    throw new AppError(
      409,
      `Cannot release ${amount} — only ${existing.allocatedAmount} is currently allocated.`
    );
  }

  await logActivity({
    user: context.actorId,
    action: "BUDGET_AMOUNT_RELEASED",
    module: "FINANCE",
    description: `Released ${amount} back to Budget Setup ${budgetSetupId}.`,
    entityType: "BudgetSetup",
    entityId: updated._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return {
    budgetSetupId: String(updated._id),
    originalAmount: updated.originalAmount,
    allocatedAmount: updated.allocatedAmount,
    remainingAmount: updated.originalAmount - updated.allocatedAmount,
    status: updated.status,
  };
}

// ---------------------------------------------------------------------------
// Supporting documents — sanction letters, approval memos, etc. Managed as
// separate endpoints (not bundled into create/update) since a multipart file
// upload can't share a request body with the JSON create/update payload.
// ---------------------------------------------------------------------------

export async function addBudgetSetupDocument(
  id: string,
  file: Express.Multer.File,
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);

  doc.attachments.push({
    fileName: file.filename,
    originalName: file.originalname,
    fileUrl: `/uploads/budget-setups/${file.filename}`,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: context.actorId,
    uploadedAt: new Date(),
  });
  doc.updatedBy = context.actorId;
  await doc.save();

  await logActivity({
    user: context.actorId,
    action: "BUDGET_SETUP_DOCUMENT_UPLOADED",
    module: "FINANCE",
    description: `Uploaded supporting document "${file.originalname}" to Budget Setup ${id}.`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}

export async function removeBudgetSetupDocument(
  id: string,
  documentId: string,
  context: ActorContext
): Promise<BudgetSetupDto> {
  const doc = await findByIdOr404(id);
  const attachment = doc.attachments.id(documentId);
  if (!attachment) throw new AppError(404, "Document not found on this Budget Setup.");

  const originalName = attachment.originalName;
  const storedFileName = attachment.fileName;
  doc.attachments.pull({ _id: documentId });
  doc.updatedBy = context.actorId;
  await doc.save();

  // Best-effort disk cleanup — a failure here must not fail the request;
  // the DB record (source of truth for what's "attached") is already updated.
  try {
    fs.unlinkSync(path.join(UPLOAD_ROOT_DIR, "budget-setups", storedFileName));
  } catch (error) {
    console.error("[budget-setup] failed to delete attachment file:", error);
  }

  await logActivity({
    user: context.actorId,
    action: "BUDGET_SETUP_DOCUMENT_REMOVED",
    module: "FINANCE",
    description: `Removed supporting document "${originalName}" from Budget Setup ${id}.`,
    entityType: "BudgetSetup",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const maps = await buildLookupMaps();
  return serialize(doc, maps);
}
