import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as userNodeRoleService from "../../services/fms/user-node-role.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateUserNodeRoleInput,
  UpdateUserNodeRoleInput,
  UserNodeRoleListQuery,
  NodeUsersQuery,
} from "../../schemas/fms/user-node-role.schema";
import type { AssignmentStatus } from "../../models/fms/FmsUserNodeRole";

function actorId(req: AuthenticatedRequest) {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return req.user._id;
}

export async function createUserNodeRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateUserNodeRoleInput;
  const context = getActorContext(req);
  const assignment = await userNodeRoleService.createAssignment(body, context.actorId, context);
  sendSuccess(res, assignment, { statusCode: 201, message: "FMS role assigned successfully." });
}

export async function listUserNodeRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as UserNodeRoleListQuery;
  const { items, meta } = await userNodeRoleService.listAssignments(query);
  sendSuccess(res, items, { meta, message: "Assignments retrieved successfully." });
}

export async function getUserNodeRoleById(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const assignment = await userNodeRoleService.getAssignmentById(id);
  sendSuccess(res, assignment);
}

export async function updateUserNodeRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateUserNodeRoleInput;
  const assignment = await userNodeRoleService.updateAssignment(id, body, actorId(req));
  sendSuccess(res, assignment, { message: "Assignment updated successfully." });
}

export async function updateUserNodeRoleStatus(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: AssignmentStatus };
  const context = getActorContext(req);
  const assignment = await userNodeRoleService.updateAssignmentStatus(
    id,
    status,
    context.actorId,
    context
  );
  sendSuccess(res, assignment, {
    message: `Assignment ${status === "Active" ? "activated" : "deactivated"} successfully.`,
  });
}

export async function deleteUserNodeRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  await userNodeRoleService.removeAssignment(id, context.actorId, context);
  sendSuccess(res, null, { message: "Assignment removed successfully." });
}

export async function getUserNodes(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId } = res.locals.params as { userId: string };
  const nodes = await userNodeRoleService.getUserNodeAssignments(userId);
  sendSuccess(res, nodes, { message: "User node assignments retrieved successfully" });
}

export async function getNodeUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { nodeId } = res.locals.params as { nodeId: string };
  const { status } = res.locals.query as NodeUsersQuery;
  const users = await userNodeRoleService.getNodeUsersList(nodeId, status);
  sendSuccess(res, users, { message: "Node users retrieved successfully" });
}

export async function getMyNodes(req: AuthenticatedRequest, res: Response): Promise<void> {
  const nodes = await userNodeRoleService.getMyAccessibleNodes(actorId(req));
  sendSuccess(res, nodes, { message: "Accessible nodes retrieved successfully" });
}

export async function getMyNodeRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { nodeId } = res.locals.params as { nodeId: string };
  const roles = await userNodeRoleService.getMyRoleForNode(actorId(req), nodeId);

  if (roles.length === 0) {
    throw new AppError(403, "You do not have an active FMS role on this node.");
  }

  sendSuccess(res, { nodeId, roles });
}
