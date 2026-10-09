import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel, type FinancialYearDocument } from "../../models/fms/FinancialYear";
import { getCurrentFinancialYear } from "./financial-year.service";
import { getAllowedNodeIdsForList, getAllowedHeadIdsForList, type ActorForPermission } from "./financial-workflow.service";
import { getUserNodes, getDescendantNodeIdsGovernedBy } from "../../utils/fms/node-permission";
import type { UserRole } from "../../models/User";

/**
 * Shared primitives behind both the Dashboard and the Reports module —
 * every one of these enforces or supports the same node-scoping rule:
 * a request can never see data outside its own assigned Organization
 * Node(s), no matter what it asks for (never left to the frontend).
 */
export interface ReportActorContext extends ActorForPermission {
  actorRole: UserRole;
}

export const PENDING_STATUSES = ["PENDING_VERIFICATION", "PENDING_CHECKER_APPROVAL"] as const;
export const REJECTED_STATUSES = ["REJECTED_BY_VERIFIER", "REJECTED_BY_CHECKER"] as const;
export const FISCAL_MONTHS_FULL = [
  "April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March",
] as const;

export function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.map((id) => new Types.ObjectId(id));
}

/** `null` = unrestricted (every node). A `string[]` always filters on `field`. */
export function nodeFilter(nodeIds: string[] | null, field = "organizationNodeId"): Record<string, unknown> {
  if (nodeIds === null) return {};
  return { [field]: { $in: toObjectIds(nodeIds) } };
}

/** Sibling to nodeFilter, same contract — `null` = unrestricted (every Head). */
export function headFilter(headIds: string[] | null, field = "headId"): Record<string, unknown> {
  if (headIds === null) return {};
  return { [field]: { $in: toObjectIds(headIds) } };
}

export async function sumField(Model: mongoose.Model<any>, field: string, match: Record<string, unknown>): Promise<number> {
  const rows = await Model.aggregate<{ _id: null; sum: number }>([{ $match: match }, { $group: { _id: null, sum: { $sum: `$${field}` } } }]);
  return rows[0]?.sum ?? 0;
}

export async function countAndSum(Model: mongoose.Model<any>, match: Record<string, unknown>, amountField: string): Promise<{ count: number; amount: number }> {
  const rows = await Model.aggregate<{ _id: null; count: number; amount: number }>([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: `$${amountField}` } } },
  ]);
  return { count: rows[0]?.count ?? 0, amount: rows[0]?.amount ?? 0 };
}

/** Per-id root mapping (in-memory walk, one query, no N+1 — same shape as Bulk Upload's resolveOrganizationRoot). */
export async function resolveNodeRootMap(nodeIds: string[]): Promise<Map<string, string>> {
  const allNodes = await OrganizationNodeModel.find().select("_id parentNodeId").lean();
  const parentById = new Map(allNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));
  const map = new Map<string, string>();
  for (const id of nodeIds) {
    let current = id;
    const visited = new Set<string>();
    while (parentById.get(current)) {
      if (visited.has(current)) break;
      visited.add(current);
      current = parentById.get(current)!;
    }
    map.set(id, current);
  }
  return map;
}

/** Every Organization Node a node id could resolve up to, deduplicated. */
export async function resolveRootNodeIds(nodeIds: string[]): Promise<string[]> {
  const map = await resolveNodeRootMap(nodeIds);
  return [...new Set(map.values())];
}

/**
 * Every Scheme/Head root a head id resolves up to, deduplicated — used to
 * filter PayrollBatch's head-wise scope, since it only ever stores a
 * root-pool `schemeHeadRootNodeId` reference, never a per-record headId
 * finer-grained than that. `hierarchyPath` already encodes full ancestry
 * ("/root/.../parent/"), so the root is simply its first segment (or the
 * head itself when hierarchyPath is "/", i.e. the head IS a root).
 */
export async function resolveHeadRootIds(headIds: string[]): Promise<string[]> {
  const heads = await SchemeHeadNodeModel.find({ _id: { $in: headIds } }).select("_id hierarchyPath").lean();
  const roots = new Set<string>();
  for (const head of heads) {
    const segments = head.hierarchyPath.split("/").filter(Boolean);
    roots.add(segments.length > 0 ? segments[0] : String(head._id));
  }
  return [...roots];
}

/**
 * Dashboard/Reports-only variant of `getAllowedNodeIdsForList` — that
 * shared helper returns `null` (unrestricted) for Admin unconditionally,
 * which is also relied on by Budget Setup/Allocation/Expenditure/Payroll/
 * Beneficiary's own list/export screens (out of scope for this change).
 * Here specifically, an Admin with at least one active `FmsUserNodeRole`
 * assignment (any role — Admin isn't tied to one of Maker/Verifier/
 * Checker, so this is a role-agnostic union of every node they hold any
 * assignment on) is scoped to that assignment set, descendant-expanded the
 * same way Maker/Verifier/Checker already are; an Admin with zero
 * assignments stays unrestricted, so an existing unassigned Admin sees no
 * behavior change.
 */
export async function getAllowedNodeIdsForReporting(actor: ReportActorContext): Promise<string[] | null> {
  if (actor.actorRole === "Admin") {
    const nodes = await getUserNodes(actor.actorId);
    if (nodes.length === 0) return null;
    const assignedNodeIds = [...new Set(nodes.map((node) => node.nodeId))];
    return getDescendantNodeIdsGovernedBy(assignedNodeIds);
  }
  return getAllowedNodeIdsForList(actor);
}

export async function resolveEffectiveNodeIds(actor: ReportActorContext, requestedNodeId: string | undefined): Promise<string[] | null> {
  const allowed = await getAllowedNodeIdsForReporting(actor);
  if (!requestedNodeId) return allowed;
  if (allowed !== null && !allowed.includes(requestedNodeId)) {
    throw new AppError(403, "You do not have access to this Organization Node.");
  }
  return [requestedNodeId];
}

/** Head-wise counterpart to resolveEffectiveNodeIds — same contract, same non-trust-the-client validation. */
export async function resolveEffectiveHeadIds(actor: ReportActorContext, requestedHeadId: string | undefined): Promise<string[] | null> {
  const allowed = await getAllowedHeadIdsForList(actor);
  if (!requestedHeadId) return allowed;
  if (allowed !== null && !allowed.includes(requestedHeadId)) {
    throw new AppError(403, "You do not have access to this Scheme/Head.");
  }
  return [requestedHeadId];
}

export async function resolveFinancialYear(financialYearId: string | undefined): Promise<FinancialYearDocument> {
  if (!financialYearId) return getCurrentFinancialYear();
  const year = await FinancialYearModel.findById(financialYearId);
  if (!year) throw new AppError(404, "Financial Year not found.");
  return year;
}

export function buildFiscalTrendFromMonthKeys(fyStartDate: Date, amountByMonthKey: Map<string, number>): Array<{ month: string; amount: number }> {
  const points: Array<{ month: string; amount: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(fyStartDate.getUTCFullYear(), fyStartDate.getUTCMonth() + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    points.push({ month: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }), amount: amountByMonthKey.get(key) ?? 0 });
  }
  return points;
}

/** Batched id->name lookup — one query, not N. */
export async function resolveNames(Model: mongoose.Model<any>, ids: Array<Types.ObjectId | null | undefined>, nameField: string): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map(String))];
  if (uniq.length === 0) return new Map();
  const docs = await Model.find({ _id: { $in: uniq } })
    .select(nameField)
    .lean();
  return new Map(docs.map((d) => [String((d as { _id: Types.ObjectId })._id), (d as Record<string, string>)[nameField]]));
}
