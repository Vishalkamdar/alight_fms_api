import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext, getActorContextWithRole } from "../../utils/requestContext";
import * as userHeadRoleService from "../../services/fms/user-head-role.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateUserHeadRoleInput,
  UpdateHeadAssignmentStatusInput,
  UserHeadRoleListQuery,
} from "../../schemas/fms/user-head-role.schema";

function actorId(req: AuthenticatedRequest) {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return req.user._id;
}

export async function createUserHeadRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateUserHeadRoleInput;
  const context = getActorContext(req);
  const assignment = await userHeadRoleService.createAssignment(body, context.actorId, context);
  sendSuccess(res, assignment, { statusCode: 201, message: "Head assigned successfully." });
}

export async function listUserHeadRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as UserHeadRoleListQuery;
  const { items, meta } = await userHeadRoleService.listAssignments(query);
  sendSuccess(res, items, { meta, message: "Assignments retrieved successfully." });
}

export async function getUserHeadRoleById(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const assignment = await userHeadRoleService.getAssignmentById(id);
  sendSuccess(res, assignment);
}

export async function updateUserHeadRoleStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as UpdateHeadAssignmentStatusInput;
  const context = getActorContext(req);
  const assignment = await userHeadRoleService.updateAssignmentStatus(id, status, context.actorId, context);
  sendSuccess(res, assignment, { message: `Assignment ${status === "Active" ? "activated" : "deactivated"} successfully.` });
}

export async function deleteUserHeadRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  await userHeadRoleService.removeAssignment(id, context.actorId, context);
  sendSuccess(res, null, { message: "Assignment removed successfully." });
}

export async function getUserHeads(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId } = res.locals.params as { userId: string };
  const heads = await userHeadRoleService.getUserHeadAssignments(userId);
  sendSuccess(res, heads, { message: "User head assignments retrieved successfully" });
}

export async function getMyHeads(req: AuthenticatedRequest, res: Response): Promise<void> {
  const heads = await userHeadRoleService.getMyAccessibleHeads(actorId(req));
  sendSuccess(res, heads, { message: "Accessible heads retrieved successfully" });
}

export async function getMyAllocatableHeads(req: AuthenticatedRequest, res: Response): Promise<void> {
  const context = getActorContextWithRole(req);
  const heads = await userHeadRoleService.getMyAllocatableHeads(context);
  sendSuccess(res, heads, { message: "Allocatable heads retrieved successfully" });
}
