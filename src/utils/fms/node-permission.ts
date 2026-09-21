import { Types } from "mongoose";
import { FmsUserNodeRoleModel, type FmsRole } from "../../models/fms/FmsUserNodeRole";
import { FmsNodeRoleConfigModel } from "../../models/fms/FmsNodeRoleConfig";

type IdLike = string | Types.ObjectId;

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

export async function hasNodeRole(userId: IdLike, nodeId: IdLike, role: FmsRole): Promise<boolean> {
  const [assigned, enabled] = await Promise.all([
    FmsUserNodeRoleModel.exists({ user: userId, node: nodeId, role, status: "Active" }),
    isNodeRoleEnabled(nodeId, role),
  ]);
  return Boolean(assigned) && enabled;
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
