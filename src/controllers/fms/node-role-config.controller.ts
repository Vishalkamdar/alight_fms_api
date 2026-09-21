import { Response } from "express";
import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import * as nodeRoleConfigService from "../../services/fms/node-role-config.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateNodeRoleConfigInput,
  NodeRoleConfigListQuery,
  UpdateNodeRoleConfigInput,
} from "../../schemas/fms/node-role-config.schema";

function actorId(req: AuthenticatedRequest): Types.ObjectId {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return req.user._id;
}

export async function createNodeRoleConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateNodeRoleConfigInput;
  const config = await nodeRoleConfigService.createConfig(body, actorId(req), req.ip ?? null);
  sendSuccess(res, config, { statusCode: 201, message: "Node role configuration created." });
}

export async function updateNodeRoleConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { nodeId } = res.locals.params as { nodeId: string };
  const body = res.locals.body as UpdateNodeRoleConfigInput;
  const config = await nodeRoleConfigService.updateConfig(nodeId, body, actorId(req), req.ip ?? null);
  sendSuccess(res, config, { message: "Node role configuration updated." });
}

export async function getNodeRoleConfig(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { nodeId } = res.locals.params as { nodeId: string };
  const config = await nodeRoleConfigService.getConfigByNode(nodeId);
  sendSuccess(res, config);
}

export async function listNodeRoleConfigs(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as NodeRoleConfigListQuery;
  const { items, meta } = await nodeRoleConfigService.listConfigs(query);
  sendSuccess(res, items, { meta });
}
