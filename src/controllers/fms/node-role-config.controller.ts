import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as nodeRoleConfigService from "../../services/fms/node-role-config.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateNodeRoleConfigInput,
  NodeRoleConfigListQuery,
  UpdateNodeRoleConfigInput,
} from "../../schemas/fms/node-role-config.schema";

export async function createNodeRoleConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateNodeRoleConfigInput;
  const context = getActorContext(req);
  const config = await nodeRoleConfigService.createConfig(body, context.actorId, context);
  sendSuccess(res, config, { statusCode: 201, message: "Node role configuration created." });
}

export async function updateNodeRoleConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { nodeId } = res.locals.params as { nodeId: string };
  const body = res.locals.body as UpdateNodeRoleConfigInput;
  const context = getActorContext(req);
  const config = await nodeRoleConfigService.updateConfig(nodeId, body, context.actorId, context);
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
