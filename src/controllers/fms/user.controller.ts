import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import * as userService from "../../services/fms/user.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { CreateUserInput, UpdateUserInput, UserListQuery } from "../../schemas/fms/user.schema";

function requestContext(req: AuthenticatedRequest): userService.RequestContext {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return { actorId: req.user._id, actorRole: req.user.role, ipAddress: req.ip ?? null };
}

export async function createUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateUserInput;
  const user = await userService.createUser(body, requestContext(req));
  sendSuccess(res, user, { statusCode: 201, message: "User created successfully." });
}

export async function listUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as UserListQuery;
  const { items, meta } = await userService.listUsers(query);
  sendSuccess(res, items, { meta, message: "Users retrieved successfully." });
}

export async function getUser(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const user = await userService.getUserById(id);
  sendSuccess(res, user);
}

export async function updateUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateUserInput;
  const user = await userService.updateUser(id, body, requestContext(req));
  sendSuccess(res, user, { message: "User updated successfully." });
}

export async function updateUserStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { isActive } = res.locals.body as { isActive: boolean };
  const user = await userService.updateUserStatus(id, isActive, requestContext(req));
  sendSuccess(res, user, {
    message: `User ${isActive ? "activated" : "deactivated"} successfully.`,
  });
}
