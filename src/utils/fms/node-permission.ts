import { Types } from "mongoose";
import { FmsUserNodeRoleModel, type FmsRole } from "../../models/fms/FmsUserNodeRole";
import { FmsNodeRoleConfigModel } from "../../models/fms/FmsNodeRoleConfig";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import type { UserRole } from "../../models/User";

type IdLike = string | Types.ObjectId;

const SYSTEM_ROLE_TO_FMS_ROLE: Partial<Record<UserRole, FmsRole>> = {
  "FMS Operational User - Maker": "Maker",
  "FMS Operational User - Verifier": "Verifier",
  "FMS Operational User - Checker": "Checker",
};

/**
 * The single FmsRole a "FMS Operational User - X" system role corresponds
 * to, or null for Super Admin/Admin (who aren't restricted to one role —
 * their FmsUserNodeRole assignments, if any, may be any of the three).
 * Used both to validate node-role assignments match the assignee's system
 * role, and to scope Maker's own Budget Management views to their nodes.
 */
export function operationalRoleForSystemRole(role: UserRole): FmsRole | null {
  return SYSTEM_ROLE_TO_FMS_ROLE[role] ?? null;
}

/**
 * Core permission primitives, reused by every future FMS module (Budget,
 * Fund Allocation, Vendor, Invoice, Payment, Approval, Reports, ...) to
 * decide what a user may do on a given node — never a global role check.
 *
 * A role only grants access when BOTH are true:
 *   1. The user holds an Active FmsUserNodeRole for that role on that node.
 *   2. Super Admin currently has that role enabled for that node
 *      (FmsNodeRoleConfig). Disabling a role blocks access immediately,
 *      even for users who were previously assigned it — see
 *      "ROLE CHANGE BEHAVIOR": the assignment record itself is preserved
 *      for history, only live access is gated.
 */

const ROLE_ENABLED_FIELD: Record<FmsRole, "makerEnabled" | "verifierEnabled" | "checkerEnabled"> = {
  Maker: "makerEnabled",
  Verifier: "verifierEnabled",
  Checker: "checkerEnabled",
};

export async function isNodeRoleEnabled(nodeId: IdLike, role: FmsRole): Promise<boolean> {
  const config = await FmsNodeRoleConfigModel.findOne({ node: nodeId, status: "Active" })
    .select(ROLE_ENABLED_FIELD[role])
    .lean();
  if (!config) return false;
  return Boolean(config[ROLE_ENABLED_FIELD[role]]);
}

/**
 * Walks parentNodeId up from `nodeId` (itself first) and returns the
 * nearest node — itself or an ancestor — that has an Active
 * FmsNodeRoleConfig: the node whose Maker/Verifier/Checker settings
 * actually govern this one. A sub-team under a configured department (e.g.
 * "QA Team" under "Tech") has no config of its own, so it inherits Tech's
 * — both the workflow requirement AND who's authorized to act, since
 * FmsUserNodeRole assignments are only ever created on a node that itself
 * has a config (assertRoleEnabledForNode), so an assignment on Tech IS an
 * assignment on QA Team's governing node. Returns `nodeId` itself unchanged
 * if nothing in the chain has a config (unconfigured subtree — Maker-only,
 * everything auto-approves, same as before this existed).
 */
export async function resolveGoverningNodeId(nodeId: IdLike): Promise<string> {
  let currentId: string | null = String(nodeId);
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) return String(nodeId);
    visited.add(currentId);

    const hasConfig = await FmsNodeRoleConfigModel.exists({ node: currentId, status: "Active" });
    if (hasConfig) return currentId;

    const current: { parentNodeId?: Types.ObjectId | null } | null = await OrganizationNodeModel.findById(
      currentId
    )
      .select("parentNodeId")
      .lean();
    currentId = current?.parentNodeId ? String(current.parentNodeId) : null;
  }

  return String(nodeId);
}

/**
 * Every Organization Node whose resolveGoverningNodeId() lands on one of
 * `governingNodeIds` — including those governing nodes themselves. Used to
 * expand "nodes I'm assigned Verifier/Checker on" into "nodes whose pending
 * transactions I can actually see/act on," since a node assigned to a
 * governing node implicitly covers every ungoverned descendant too.
 * Resolves the whole active tree in two queries rather than walking each
 * node individually.
 */
export async function getDescendantNodeIdsGovernedBy(governingNodeIds: string[]): Promise<string[]> {
  if (governingNodeIds.length === 0) return [];
  const governingSet = new Set(governingNodeIds);

  const [allNodes, activeConfigs] = await Promise.all([
    OrganizationNodeModel.find({ status: "Active" }).select("_id parentNodeId").lean(),
    FmsNodeRoleConfigModel.find({ status: "Active" }).select("node").lean(),
  ]);

  const parentById = new Map(allNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));
  const configuredNodeIds = new Set(activeConfigs.map((c) => String(c.node)));

  const governingNodeCache = new Map<string, string>();
  function resolveGoverning(nodeId: string, visited: Set<string>): string {
    if (governingNodeCache.has(nodeId)) return governingNodeCache.get(nodeId)!;
    if (visited.has(nodeId)) return nodeId;
    visited.add(nodeId);

    if (configuredNodeIds.has(nodeId)) {
      governingNodeCache.set(nodeId, nodeId);
      return nodeId;
    }
    const parentId = parentById.get(nodeId) ?? null;
    const result = parentId ? resolveGoverning(parentId, visited) : nodeId;
    governingNodeCache.set(nodeId, result);
    return result;
  }

  return allNodes
    .map((n) => String(n._id))
    .filter((id) => governingSet.has(resolveGoverning(id, new Set())));
}

/**
 * Self + every real ancestor of `nodeId` via parentNodeId, full chain to
 * root — unlike resolveGoverningNodeId, this never stops at the first
 * configured node. Used to grant an ancestor-assigned Maker authority over
 * every descendant, regardless of whether that descendant has its own
 * FmsNodeRoleConfig (see hasNodeRole).
 */
export async function getAncestorNodeIds(nodeId: IdLike): Promise<string[]> {
  const ancestors: string[] = [];
  let currentId: string | null = String(nodeId);
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    ancestors.push(currentId);

    const current: { parentNodeId?: Types.ObjectId | null } | null = await OrganizationNodeModel.findById(
      currentId
    )
      .select("parentNodeId")
      .lean();
    currentId = current?.parentNodeId ? String(current.parentNodeId) : null;
  }

  return ancestors;
}

/**
 * Self + every true descendant of the given node ids, via the real
 * parentNodeId tree — unlike getDescendantNodeIdsGovernedBy, this never
 * stops at a configured boundary. The inverse of getAncestorNodeIds: used to
 * widen a Maker's own assigned nodes into everything they may now act on.
 */
export async function getTrueDescendantNodeIds(ancestorNodeIds: string[]): Promise<string[]> {
  if (ancestorNodeIds.length === 0) return [];
  const ancestorSet = new Set(ancestorNodeIds);

  const allNodes = await OrganizationNodeModel.find({ status: "Active" }).select("_id parentNodeId").lean();
  const parentById = new Map(allNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));

  const descendantCache = new Map<string, boolean>();
  function isWithin(nodeId: string, visited: Set<string>): boolean {
    if (ancestorSet.has(nodeId)) return true;
    if (descendantCache.has(nodeId)) return descendantCache.get(nodeId)!;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);

    const parentId = parentById.get(nodeId) ?? null;
    const result = parentId ? isWithin(parentId, visited) : false;
    descendantCache.set(nodeId, result);
    return result;
  }

  return allNodes.map((n) => String(n._id)).filter((id) => isWithin(id, new Set()));
}

/**
 * Whether the user may act as `role` on `nodeId` right now. Role enablement
 * is always gated on `nodeId`'s GOVERNING node (itself, or its nearest
 * configured ancestor — see resolveGoverningNodeId): if the role is
 * disabled there, nobody can act, full stop.
 *
 * Who counts as assigned differs by role: Maker authority flows DOWN a
 * parent→child chain — an assignment on this node OR any real ancestor
 * qualifies (getAncestorNodeIds), regardless of whether intervening nodes
 * have their own FmsNodeRoleConfig. Verifier/Checker stay exact — only an
 * assignment at the node's own governing node counts, preserving
 * per-department approval authority even when an ancestor's Maker has
 * pushed a transaction down into it.
 */
export async function hasNodeRole(userId: IdLike, nodeId: IdLike, role: FmsRole): Promise<boolean> {
  const governingNodeId = await resolveGoverningNodeId(nodeId);
  const enabled = await isNodeRoleEnabled(governingNodeId, role);
  if (!enabled) return false;

  if (role === "Maker") {
    const ancestorNodeIds = await getAncestorNodeIds(nodeId);
    const assigned = await FmsUserNodeRoleModel.exists({
      user: userId,
      node: { $in: ancestorNodeIds },
      role: "Maker",
      status: "Active",
    });
    return Boolean(assigned);
  }

  const assigned = await FmsUserNodeRoleModel.exists({ user: userId, node: governingNodeId, role, status: "Active" });
  return Boolean(assigned);
}

export async function hasAnyNodeRole(
  userId: IdLike,
  nodeId: IdLike,
  roles: FmsRole[]
): Promise<boolean> {
  const results = await Promise.all(roles.map((role) => hasNodeRole(userId, nodeId, role)));
  return results.some(Boolean);
}

/** Every active + currently-enabled role the user holds on this specific node. */
export async function getUserNodeRole(userId: IdLike, nodeId: IdLike): Promise<FmsRole[]> {
  const assignments = await FmsUserNodeRoleModel.find({
    user: userId,
    node: nodeId,
    status: "Active",
  })
    .select("role")
    .lean();

  const roles = assignments.map((assignment) => assignment.role);
  const enabledFlags = await Promise.all(roles.map((role) => isNodeRoleEnabled(nodeId, role)));
  return roles.filter((_, index) => enabledFlags[index]);
}

export interface UserNodeAccess {
  nodeId: string;
  role: FmsRole;
}

/** Every (node, role) pair the user currently has active + enabled access to. */
export async function getUserNodes(userId: IdLike): Promise<UserNodeAccess[]> {
  const assignments = await FmsUserNodeRoleModel.find({ user: userId, status: "Active" })
    .select("node role")
    .lean();

  const enabledFlags = await Promise.all(
    assignments.map((assignment) => isNodeRoleEnabled(assignment.node, assignment.role))
  );

  return assignments
    .filter((_, index) => enabledFlags[index])
    .map((assignment) => ({
      nodeId: String(assignment.node),
      role: assignment.role,
    }));
}

export interface NodeUserAccess {
  userId: string;
  role: FmsRole;
}

/** Every (user, role) pair currently active + enabled on this node. */
export async function getNodeUsers(nodeId: IdLike): Promise<NodeUserAccess[]> {
  const assignments = await FmsUserNodeRoleModel.find({ node: nodeId, status: "Active" })
    .select("user role")
    .lean();

  const enabledFlags = await Promise.all(
    assignments.map((assignment) => isNodeRoleEnabled(nodeId, assignment.role))
  );

  return assignments
    .filter((_, index) => enabledFlags[index])
    .map((assignment) => ({
      userId: String(assignment.user),
      role: assignment.role,
    }));
}
