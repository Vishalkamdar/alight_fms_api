import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { hasNodeRole, isNodeRoleEnabled, getUserNodes } from "../../utils/fms/node-permission";
import { FmsNodeRoleConfigModel } from "../../models/fms/FmsNodeRoleConfig";
import {
  FinancialWorkflowHistoryModel,
  type FinancialWorkflowModule,
} from "../../models/fms/FinancialWorkflowHistory";
import type { UserRole } from "../../models/User";
import type { FmsRole } from "../../models/fms/FmsUserNodeRole";
import { APPROVAL_STATUSES, type ApprovalStatus, type WorkflowSnapshot } from "../../types/fms/financial-workflow.types";

export { APPROVAL_STATUSES };
export type { ApprovalStatus, WorkflowSnapshot };

/**
 * Shared Maker / Verifier / Checker approval engine — the global workflow
 * (GLOBAL FINANCIAL APPROVAL WORKFLOW spec) is identical in shape across
 * every financial module (Budget Setup, Budget Allocation, and future
 * Fund Allocation / Vendor Invoices / Payments), so the state machine,
 * permission checks, and history logging live here once rather than being
 * re-implemented per module.
 */

export interface ResolvedWorkflow {
  snapshot: WorkflowSnapshot;
  /** The status a brand-new record gets immediately after Maker submission. */
  initialStatus: ApprovalStatus;
}

/**
 * Reads the target Organization Node's Maker/Verifier/Checker configuration
 * and derives both the immutable snapshot to store on the new record (§20 —
 * a later config change must never reinterpret an existing record) and the
 * status it starts in. Case 4 (Maker only) resolves straight to APPROVED —
 * no approval stage, no Holding period.
 */
export async function resolveWorkflowForNode(nodeId: string | Types.ObjectId): Promise<ResolvedWorkflow> {
  const config = await FmsNodeRoleConfigModel.findOne({ node: nodeId, status: "Active" }).lean();
  const verifierRequired = Boolean(config?.verifierEnabled);
  const checkerRequired = Boolean(config?.checkerEnabled);

  const initialStatus: ApprovalStatus = verifierRequired
    ? "PENDING_VERIFICATION"
    : checkerRequired
      ? "PENDING_CHECKER_APPROVAL"
      : "APPROVED";

  return { snapshot: { makerRequired: true, verifierRequired, checkerRequired }, initialStatus };
}

export interface ActorForPermission {
  actorId: Types.ObjectId;
  actorRole: UserRole;
}

/**
 * Every Organization Node id the user may act as `role` on right now — or
 * the literal "ALL" for Super Admin, who bypasses per-node assignment.
 * Used to scope "my pending approvals" queries (§3/§4 — Verifier/Checker
 * only ever see what they're actually authorized to act on).
 */
export async function getMyActionableNodeIds(
  actor: ActorForPermission,
  role: FmsRole
): Promise<string[] | "ALL"> {
  if (actor.actorRole === "Super Admin") return "ALL";
  const nodes = await getUserNodes(actor.actorId);
  return nodes.filter((node) => node.role === role).map((node) => node.nodeId);
}

/**
 * Super Admin bypasses per-node Maker/Verifier/Checker assignment (matches
 * how Super Admin already bypasses other node-scoped restrictions
 * elsewhere in this app) — everyone else must hold an Active assignment for
 * that exact role on that exact node, with the role currently enabled
 * there. §12: a Maker on Department A gets no permission on Department B.
 */
async function assertHasRoleOnNode(actor: ActorForPermission, nodeId: string, role: FmsRole): Promise<void> {
  if (actor.actorRole === "Super Admin") return;
  const allowed = await hasNodeRole(actor.actorId, nodeId, role);
  if (!allowed) {
    throw new AppError(403, `You are not an authorized ${role} for this Organization Node.`, {
      role: [`${role} access is required for this node.`],
    });
  }
}

export async function assertMakerPermission(actor: ActorForPermission, nodeId: string): Promise<void> {
  await assertHasRoleOnNode(actor, nodeId, "Maker");
}

export async function assertVerifierPermission(actor: ActorForPermission, nodeId: string): Promise<void> {
  await assertHasRoleOnNode(actor, nodeId, "Verifier");
}

export async function assertCheckerPermission(actor: ActorForPermission, nodeId: string): Promise<void> {
  await assertHasRoleOnNode(actor, nodeId, "Checker");
}

/** Whether the current user is enabled as an approver of the given kind on this node. */
export async function canActAsRoleOnNode(
  actor: ActorForPermission,
  nodeId: string,
  role: FmsRole
): Promise<boolean> {
  if (actor.actorRole === "Super Admin") return isNodeRoleEnabled(nodeId, role);
  return hasNodeRole(actor.actorId, nodeId, role);
}

interface RecordLike {
  makerId: Types.ObjectId;
  verifierId: Types.ObjectId | null;
  checkerId: Types.ObjectId | null;
  workflowSnapshot: WorkflowSnapshot;
}

/** §5 — a Maker can never verify or approve their own transaction, no exceptions. */
export function assertNotSelfApproving(record: RecordLike, actorId: Types.ObjectId): void {
  if (String(record.makerId) === String(actorId)) {
    throw new AppError(403, "A Maker cannot verify or approve their own transaction.");
  }
}

/** What `verify` transitions a record to — the terminal approval if Checker is disabled (§6 Case 3). */
export function computeVerifyTransition(snapshot: WorkflowSnapshot): { nextStatus: ApprovalStatus; isFinal: boolean } {
  return snapshot.checkerRequired
    ? { nextStatus: "PENDING_CHECKER_APPROVAL", isFinal: false }
    : { nextStatus: "APPROVED", isFinal: true };
}

interface RecordHistoryContext {
  module: FinancialWorkflowModule;
  recordId: Types.ObjectId;
  organizationNodeId: Types.ObjectId | null;
  amount: number;
}

export async function recordWorkflowEvent(
  context: RecordHistoryContext,
  event: {
    action: string;
    userId: Types.ObjectId | null;
    userRole: string | null;
    previousStatus: ApprovalStatus | null;
    newStatus: ApprovalStatus;
    holdingAmount: number;
    remarks?: string | null;
    ipAddress: string | null;
  }
): Promise<void> {
  await FinancialWorkflowHistoryModel.create({
    module: context.module,
    recordId: context.recordId,
    organizationNodeId: context.organizationNodeId,
    amount: context.amount,
    action: event.action,
    userId: event.userId,
    userRole: event.userRole,
    previousStatus: event.previousStatus,
    newStatus: event.newStatus,
    holdingAmount: event.holdingAmount,
    remarks: event.remarks ?? null,
    ipAddress: event.ipAddress,
  });
}
