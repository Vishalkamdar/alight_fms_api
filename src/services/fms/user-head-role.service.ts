import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { UserModel } from "../../models/User";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import {
  FmsUserHeadRoleModel,
  FmsUserHeadRoleDocument,
  type HeadAssignmentStatus,
} from "../../models/fms/FmsUserHeadRole";
import { FmsUserHeadRoleAuditModel, type FmsHeadAssignmentAction } from "../../models/fms/FmsUserHeadRoleAudit";
import { getAllowedHeadIdsForList, type ActorForPermission } from "./financial-workflow.service";
import type { CreateUserHeadRoleInput, UserHeadRoleListQuery } from "../../schemas/fms/user-head-role.schema";

type IdLike = string | Types.ObjectId;

interface ActorContext {
  ipAddress?: string | null;
  userAgent?: string | null;
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

async function assertHeadExistsAndActive(headId: string) {
  const head = await SchemeHeadNodeModel.findById(headId);
  if (!head) {
    throw new AppError(404, "Scheme/Head Node not found.", { head: ["Head not found."] });
  }
  if (head.status !== "Active") {
    throw new AppError(422, "This Scheme/Head Node is not active.", { head: ["Head is not active."] });
  }
  return head;
}

async function ensureUserExists(userId: string): Promise<void> {
  const exists = await UserModel.exists({ _id: userId });
  if (!exists) throw new AppError(404, "User not found.");
}

interface WriteAuditParams {
  assignment: Types.ObjectId | null;
  user: Types.ObjectId;
  head: Types.ObjectId;
  action: FmsHeadAssignmentAction;
  previousStatus?: HeadAssignmentStatus | null;
  newStatus?: HeadAssignmentStatus | null;
  performedBy: Types.ObjectId;
}

async function writeAudit(params: WriteAuditParams): Promise<void> {
  await FmsUserHeadRoleAuditModel.create({
    assignment: params.assignment,
    user: params.user,
    head: params.head,
    action: params.action,
    previousStatus: params.previousStatus ?? null,
    newStatus: params.newStatus ?? null,
    performedBy: params.performedBy,
  });
}

export async function createAssignment(
  input: CreateUserHeadRoleInput,
  actorId: Types.ObjectId,
  context: ActorContext = {}
): Promise<FmsUserHeadRoleDocument> {
  await assertUserExistsAndActive(input.user);
  await assertHeadExistsAndActive(input.head);

  const existing = await FmsUserHeadRoleModel.findOne({ user: input.user, head: input.head });

  if (existing) {
    if (existing.status === "Active") {
      throw new AppError(409, "This user already has an active assignment for this Head.", {
        head: ["Duplicate active assignment."],
      });
    }

    const previousStatus = existing.status;
    existing.status = "Active";
    existing.updatedBy = actorId;
    await existing.save();

    await writeAudit({
      assignment: existing._id,
      user: existing.user,
      head: existing.head,
      action: "Head Activated",
      previousStatus,
      newStatus: "Active",
      performedBy: actorId,
    });

    await logActivity({
      user: actorId,
      action: "USER_HEAD_ASSIGNED",
      module: "USER",
      description: "Reactivated Head assignment for user.",
      entityType: "FmsUserHeadRole",
      entityId: existing._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return existing;
  }

  const created = await FmsUserHeadRoleModel.create({
    user: input.user,
    head: input.head,
    status: input.status ?? "Active",
    assignedBy: actorId,
    assignedAt: new Date(),
    updatedBy: actorId,
  });

  await writeAudit({
    assignment: created._id,
    user: created.user,
    head: created.head,
    action: "Head Assigned",
    newStatus: created.status,
    performedBy: actorId,
  });

  await logActivity({
    user: actorId,
    action: "USER_HEAD_ASSIGNED",
    module: "USER",
    description: "Assigned Head to user.",
    entityType: "FmsUserHeadRole",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return created;
}

export async function getAssignmentById(id: string): Promise<FmsUserHeadRoleDocument> {
  const assignment = await FmsUserHeadRoleModel.findById(id);
  if (!assignment) {
    throw new AppError(404, "Assignment not found.");
  }
  return assignment;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listAssignments(query: UserHeadRoleListQuery): Promise<ListResult<FmsUserHeadRoleDocument>> {
  const filter: Record<string, unknown> = {};
  if (query.user) filter.user = query.user;
  if (query.head) filter.head = query.head;
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    FmsUserHeadRoleModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FmsUserHeadRoleModel.countDocuments(filter),
  ]);

  return {
    items,
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export async function updateAssignmentStatus(
  id: string,
  status: HeadAssignmentStatus,
  actorId: Types.ObjectId,
  context: ActorContext = {}
): Promise<FmsUserHeadRoleDocument> {
  const assignment = await getAssignmentById(id);
  if (assignment.status === status) {
    return assignment;
  }

  if (status === "Active") {
    const duplicate = await FmsUserHeadRoleModel.findOne({
      _id: { $ne: assignment._id },
      user: assignment.user,
      head: assignment.head,
      status: "Active",
    });
    if (duplicate) {
      throw new AppError(409, "This user already has another active assignment for this Head.");
    }
  }

  const previousStatus = assignment.status;
  assignment.status = status;
  assignment.updatedBy = actorId;
  await assignment.save();

  await writeAudit({
    assignment: assignment._id,
    user: assignment.user,
    head: assignment.head,
    action: status === "Active" ? "Head Activated" : "Head Deactivated",
    previousStatus,
    newStatus: status,
    performedBy: actorId,
  });

  await logActivity({
    user: actorId,
    action: status === "Active" ? "USER_HEAD_ASSIGNED" : "USER_HEAD_REMOVED",
    module: "USER",
    description: `${status === "Active" ? "Activated" : "Deactivated"} Head assignment for user.`,
    entityType: "FmsUserHeadRole",
    entityId: assignment._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return assignment;
}

export async function removeAssignment(id: string, actorId: Types.ObjectId, context: ActorContext = {}): Promise<void> {
  const assignment = await getAssignmentById(id);

  await writeAudit({
    assignment: assignment._id,
    user: assignment.user,
    head: assignment.head,
    action: "Head Removed",
    previousStatus: assignment.status,
    performedBy: actorId,
  });

  await logActivity({
    user: actorId,
    action: "USER_HEAD_REMOVED",
    module: "USER",
    description: "Removed Head assignment for user.",
    entityType: "FmsUserHeadRole",
    entityId: assignment._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  await assignment.deleteOne();
}

interface UserHeadAssignmentDto {
  _id: string;
  head: { _id: string; name: string } | null;
  status: HeadAssignmentStatus;
}

export async function getUserHeadAssignments(userId: string): Promise<UserHeadAssignmentDto[]> {
  await ensureUserExists(userId);

  const assignments = await FmsUserHeadRoleModel.find({ user: userId }).sort({ assignedAt: -1 });

  const headIds = [...new Set(assignments.map((assignment) => String(assignment.head)))];
  const heads = await SchemeHeadNodeModel.find({ _id: { $in: headIds } }).select("name");
  const headById = new Map(heads.map((head) => [String(head._id), { _id: String(head._id), name: head.name }]));

  return assignments.map((assignment) => ({
    _id: String(assignment._id),
    head: headById.get(String(assignment.head)) ?? null,
    status: assignment.status,
  }));
}

export interface MyHeadAccessDto {
  headId: string;
  headName: string;
}

export async function getMyAccessibleHeads(userId: IdLike): Promise<MyHeadAccessDto[]> {
  const assignments = await FmsUserHeadRoleModel.find({ user: userId, status: "Active" });

  const headIds = [...new Set(assignments.map((assignment) => String(assignment.head)))];
  const heads = await SchemeHeadNodeModel.find({ _id: { $in: headIds } }).select("name");
  const headById = new Map(heads.map((head) => [String(head._id), head.name]));

  return assignments
    .filter((assignment) => headById.has(String(assignment.head)))
    .map((assignment) => ({
      headId: String(assignment.head),
      headName: headById.get(String(assignment.head))!,
    }));
}

export interface AllocatableHeadDto {
  headId: string;
  name: string;
  parentHeadId: string | null;
}

/**
 * The descendant-expanded, authorization-backed shape the Dashboard/Reports
 * Head filter picker actually consumes — mirrors
 * budget-allocation.service.ts's getMyAllocatableNodes exactly. `null`
 * means unrestricted (the frontend falls back to the full Scheme/Head
 * tree); an array (possibly empty) means "only these."
 */
export async function getMyAllocatableHeads(actor: ActorForPermission): Promise<AllocatableHeadDto[] | null> {
  const allowedHeadIds = await getAllowedHeadIdsForList(actor);
  if (allowedHeadIds === null) return null;
  if (allowedHeadIds.length === 0) return [];

  const heads = await SchemeHeadNodeModel.find({ _id: { $in: allowedHeadIds }, status: "Active" })
    .select("name parentNodeId")
    .lean();

  return heads.map((head) => ({
    headId: String(head._id),
    name: head.name,
    parentHeadId: head.parentNodeId ? String(head.parentNodeId) : null,
  }));
}
