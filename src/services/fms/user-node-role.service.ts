import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { UserModel } from "../../models/User";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { NodeTypeModel } from "../../models/NodeType";
import {
  FmsUserNodeRoleModel,
  FmsUserNodeRoleDocument,
  type FmsRole,
  type AssignmentStatus,
} from "../../models/fms/FmsUserNodeRole";
import { FmsUserNodeRoleAuditModel, type FmsAssignmentAction } from "../../models/fms/FmsUserNodeRoleAudit";
import { FmsNodeRoleConfigModel } from "../../models/fms/FmsNodeRoleConfig";
import { isNodeRoleEnabled } from "../../utils/fms/node-permission";
import type {
  CreateUserNodeRoleInput,
  UpdateUserNodeRoleInput,
  UserNodeRoleListQuery,
} from "../../schemas/fms/user-node-role.schema";

type IdLike = string | Types.ObjectId;

const ROLE_ENABLED_FIELD: Record<FmsRole, "makerEnabled" | "verifierEnabled" | "checkerEnabled"> = {
  Maker: "makerEnabled",
  Verifier: "verifierEnabled",
  Checker: "checkerEnabled",
};

async function assertRoleEnabledForNode(nodeId: string, role: FmsRole): Promise<void> {
  const config = await FmsNodeRoleConfigModel.findOne({ node: nodeId });

  if (!config || config.status !== "Active") {
    throw new AppError(
      422,
      "Roles have not been configured for this node yet. Ask a Super Admin to configure it first.",
      { role: ["No active role configuration for this node."] }
    );
  }

  if (!config[ROLE_ENABLED_FIELD[role]]) {
    throw new AppError(422, `${role} is not enabled for this node.`, {
      role: [`${role} is not enabled for this node.`],
    });
  }
}

async function assertUserExistsAndActive(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new AppError(404, "User not found.", { user: ["User not found."] });
  }
  if (!user.isActive) {
    throw new AppError(422, "This user is not active.", { user: ["User is not active."] });
  }
  return user;
}

async function assertNodeExistsAndActive(nodeId: string) {
  const node = await OrganizationNodeModel.findById(nodeId);
  if (!node) {
    throw new AppError(404, "Organization node not found.", { node: ["Node not found."] });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "This organization node is not active.", {
      node: ["Node is not active."],
    });
  }
  return node;
}

async function ensureUserExists(userId: string): Promise<void> {
  const exists = await UserModel.exists({ _id: userId });
  if (!exists) throw new AppError(404, "User not found.");
}

async function ensureNodeExists(nodeId: string): Promise<void> {
  const exists = await OrganizationNodeModel.exists({ _id: nodeId });
  if (!exists) throw new AppError(404, "Organization node not found.");
}

interface WriteAuditParams {
  assignment: Types.ObjectId | null;
  user: Types.ObjectId;
  node: Types.ObjectId;
  action: FmsAssignmentAction;
  previousRole?: FmsRole | null;
  newRole?: FmsRole | null;
  previousStatus?: AssignmentStatus | null;
  newStatus?: AssignmentStatus | null;
  performedBy: Types.ObjectId;
}

async function writeAudit(params: WriteAuditParams): Promise<void> {
  await FmsUserNodeRoleAuditModel.create({
    assignment: params.assignment,
    user: params.user,
    node: params.node,
    action: params.action,
    previousRole: params.previousRole ?? null,
    newRole: params.newRole ?? null,
    previousStatus: params.previousStatus ?? null,
    newStatus: params.newStatus ?? null,
    performedBy: params.performedBy,
  });
}

export async function createAssignment(
  input: CreateUserNodeRoleInput,
  actorId: Types.ObjectId
): Promise<FmsUserNodeRoleDocument> {
  await assertUserExistsAndActive(input.user);
  await assertNodeExistsAndActive(input.node);
  await assertRoleEnabledForNode(input.node, input.role);

  const existing = await FmsUserNodeRoleModel.findOne({
    user: input.user,
    node: input.node,
    role: input.role,
  });

  if (existing) {
    if (existing.status === "Active") {
      throw new AppError(
        409,
        "This user already has an active assignment with this role on this node.",
        { role: ["Duplicate active assignment."] }
      );
    }

    const previousStatus = existing.status;
    existing.status = "Active";
    existing.updatedBy = actorId;
    await existing.save();

    await writeAudit({
      assignment: existing._id,
      user: existing.user,
      node: existing.node,
      action: "Role Activated",
      previousStatus,
      newStatus: "Active",
      performedBy: actorId,
    });

    return existing;
  }

  const created = await FmsUserNodeRoleModel.create({
    user: input.user,
    node: input.node,
    role: input.role,
    status: input.status ?? "Active",
    assignedBy: actorId,
    assignedAt: new Date(),
    updatedBy: actorId,
  });

  await writeAudit({
    assignment: created._id,
    user: created.user,
    node: created.node,
    action: "Role Assigned",
    newRole: created.role,
    newStatus: created.status,
    performedBy: actorId,
  });

  return created;
}

export async function getAssignmentById(id: string): Promise<FmsUserNodeRoleDocument> {
  const assignment = await FmsUserNodeRoleModel.findById(id);
  if (!assignment) {
    throw new AppError(404, "Assignment not found.");
  }
  return assignment;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listAssignments(
  query: UserNodeRoleListQuery
): Promise<ListResult<FmsUserNodeRoleDocument>> {
  const filter: Record<string, unknown> = {};
  if (query.user) filter.user = query.user;
  if (query.node) filter.node = query.node;
  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    FmsUserNodeRoleModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FmsUserNodeRoleModel.countDocuments(filter),
  ]);

  return {
    items,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

export async function updateAssignment(
  id: string,
  input: UpdateUserNodeRoleInput,
  actorId: Types.ObjectId
): Promise<FmsUserNodeRoleDocument> {
  const assignment = await getAssignmentById(id);

  let previousRole: FmsRole | null = null;
  let newRole: FmsRole | null = null;
  let previousStatus: AssignmentStatus | null = null;
  let newStatus: AssignmentStatus | null = null;

  const targetRole = input.role ?? assignment.role;
  const targetStatus = input.status ?? assignment.status;

  if (input.role && input.role !== assignment.role) {
    if (targetStatus === "Active") {
      await assertRoleEnabledForNode(String(assignment.node), targetRole);
      const duplicate = await FmsUserNodeRoleModel.findOne({
        _id: { $ne: assignment._id },
        user: assignment.user,
        node: assignment.node,
        role: targetRole,
        status: "Active",
      });
      if (duplicate) {
        throw new AppError(
          409,
          "This user already has an active assignment with this role on this node."
        );
      }
    }
    previousRole = assignment.role;
    assignment.role = input.role;
    newRole = input.role;
  }

  if (input.status && input.status !== assignment.status) {
    if (input.status === "Active") {
      await assertRoleEnabledForNode(String(assignment.node), targetRole);
      const duplicate = await FmsUserNodeRoleModel.findOne({
        _id: { $ne: assignment._id },
        user: assignment.user,
        node: assignment.node,
        role: targetRole,
        status: "Active",
      });
      if (duplicate) {
        throw new AppError(
          409,
          "This user already has another active assignment with this role on this node."
        );
      }
    }
    previousStatus = assignment.status;
    assignment.status = input.status;
    newStatus = input.status;
  }

  if (!newRole && !newStatus) {
    return assignment;
  }

  assignment.updatedBy = actorId;
  await assignment.save();

  await writeAudit({
    assignment: assignment._id,
    user: assignment.user,
    node: assignment.node,
    action: "Role Updated",
    previousRole,
    newRole,
    previousStatus,
    newStatus,
    performedBy: actorId,
  });

  return assignment;
}

export async function updateAssignmentStatus(
  id: string,
  status: AssignmentStatus,
  actorId: Types.ObjectId
): Promise<FmsUserNodeRoleDocument> {
  const assignment = await getAssignmentById(id);

  if (assignment.status === status) {
    return assignment;
  }

  if (status === "Active") {
    await assertRoleEnabledForNode(String(assignment.node), assignment.role);
    const duplicate = await FmsUserNodeRoleModel.findOne({
      _id: { $ne: assignment._id },
      user: assignment.user,
      node: assignment.node,
      role: assignment.role,
      status: "Active",
    });
    if (duplicate) {
      throw new AppError(
        409,
        "This user already has another active assignment with this role on this node."
      );
    }
  }

  const previousStatus = assignment.status;
  assignment.status = status;
  assignment.updatedBy = actorId;
  await assignment.save();

  await writeAudit({
    assignment: assignment._id,
    user: assignment.user,
    node: assignment.node,
    action: status === "Active" ? "Role Activated" : "Role Deactivated",
    previousStatus,
    newStatus: status,
    performedBy: actorId,
  });

  return assignment;
}

export async function removeAssignment(id: string, actorId: Types.ObjectId): Promise<void> {
  const assignment = await getAssignmentById(id);

  // Audit is written before the delete so the permanent trail survives the
  // live record being removed.
  await writeAudit({
    assignment: assignment._id,
    user: assignment.user,
    node: assignment.node,
    action: "Role Removed",
    previousRole: assignment.role,
    previousStatus: assignment.status,
    performedBy: actorId,
  });

  await assignment.deleteOne();
}

interface UserNodeAssignmentDto {
  _id: string;
  node: { _id: string; name: string; nodeType: string | null } | null;
  role: FmsRole;
  status: AssignmentStatus;
}

export async function getUserNodeAssignments(userId: string): Promise<UserNodeAssignmentDto[]> {
  await ensureUserExists(userId);

  const assignments = await FmsUserNodeRoleModel.find({ user: userId }).sort({ assignedAt: -1 });

  const nodeIds = [...new Set(assignments.map((assignment) => String(assignment.node)))];
  const nodes = await OrganizationNodeModel.find({ _id: { $in: nodeIds } }).select("name nodeTypeId");
  const nodeTypeIds = [...new Set(nodes.map((node) => String(node.nodeTypeId)))];
  const nodeTypes = await NodeTypeModel.find({ _id: { $in: nodeTypeIds } }).select("name");

  const nodeTypeNameById = new Map(nodeTypes.map((nodeType) => [String(nodeType._id), nodeType.name]));
  const nodeById = new Map(
    nodes.map((node) => [
      String(node._id),
      {
        _id: String(node._id),
        name: node.name,
        nodeType: nodeTypeNameById.get(String(node.nodeTypeId)) ?? null,
      },
    ])
  );

  return assignments.map((assignment) => ({
    _id: String(assignment._id),
    node: nodeById.get(String(assignment.node)) ?? null,
    role: assignment.role,
    status: assignment.status,
  }));
}

interface NodeUserAssignmentDto {
  _id: string;
  user: { _id: string; fullname: string; email: string } | null;
  role: FmsRole;
  status: AssignmentStatus;
}

export async function getNodeUsersList(
  nodeId: string,
  status?: AssignmentStatus
): Promise<NodeUserAssignmentDto[]> {
  await ensureNodeExists(nodeId);

  const filter: Record<string, unknown> = { node: nodeId };
  if (status) filter.status = status;

  const assignments = await FmsUserNodeRoleModel.find(filter).sort({ assignedAt: -1 });

  const userIds = [...new Set(assignments.map((assignment) => String(assignment.user)))];
  const users = await UserModel.find({ _id: { $in: userIds } }).select("fullname email");
  const userById = new Map(
    users.map((user) => [
      String(user._id),
      { _id: String(user._id), fullname: user.fullname, email: user.email },
    ])
  );

  return assignments.map((assignment) => ({
    _id: String(assignment._id),
    user: userById.get(String(assignment.user)) ?? null,
    role: assignment.role,
    status: assignment.status,
  }));
}

export interface MyNodeAccessDto {
  nodeId: string;
  nodeName: string;
  nodeType: string | null;
  role: FmsRole;
}

export async function getMyAccessibleNodes(userId: IdLike): Promise<MyNodeAccessDto[]> {
  const assignments = await FmsUserNodeRoleModel.find({ user: userId, status: "Active" });

  const nodeIds = [...new Set(assignments.map((assignment) => String(assignment.node)))];
  const nodes = await OrganizationNodeModel.find({ _id: { $in: nodeIds } }).select("name nodeTypeId");
  const nodeTypeIds = [...new Set(nodes.map((node) => String(node.nodeTypeId)))];
  const nodeTypes = await NodeTypeModel.find({ _id: { $in: nodeTypeIds } }).select("name");

  const nodeTypeNameById = new Map(nodeTypes.map((nodeType) => [String(nodeType._id), nodeType.name]));
  const nodeById = new Map(nodes.map((node) => [String(node._id), node]));

  const result: MyNodeAccessDto[] = [];
  for (const assignment of assignments) {
    const node = nodeById.get(String(assignment.node));
    if (!node) continue;
    if (!(await isNodeRoleEnabled(node._id, assignment.role))) continue;
    result.push({
      nodeId: String(node._id),
      nodeName: node.name,
      nodeType: nodeTypeNameById.get(String(node.nodeTypeId)) ?? null,
      role: assignment.role,
    });
  }
  return result;
}

export async function getMyRoleForNode(userId: IdLike, nodeId: string): Promise<FmsRole[]> {
  const assignments = await FmsUserNodeRoleModel.find({
    user: userId,
    node: nodeId,
    status: "Active",
  }).select("role");

  const roles: FmsRole[] = [];
  for (const assignment of assignments) {
    if (await isNodeRoleEnabled(nodeId, assignment.role)) {
      roles.push(assignment.role);
    }
  }
  return roles;
}
