import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as schemeHeadNodeService from "../../services/fms/scheme-head-node.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateSchemeHeadNodeInput,
  SchemeHeadNodeListQuery,
  UpdateSchemeHeadNodeInput,
} from "../../schemas/fms/scheme-head-node.schema";
import type { FmsStatus } from "../../models/SchemeHeadNode";

export async function listSchemeHeadNodes(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as SchemeHeadNodeListQuery;
  const { items, meta } = await schemeHeadNodeService.listSchemeHeadNodes(query);
  sendSuccess(res, items, { meta, message: "Scheme/Head nodes retrieved successfully." });
}

export async function getSchemeHeadTree(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const tree = await schemeHeadNodeService.getSchemeHeadTree();
  sendSuccess(res, tree);
}

export async function getSchemeHeadNode(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const node = await schemeHeadNodeService.getSchemeHeadNodeById(id);
  sendSuccess(res, node);
}

export async function getSchemeHeadChildren(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const children = await schemeHeadNodeService.getSchemeHeadChildren(id);
  sendSuccess(res, children);
}

export async function getSchemeHeadAncestors(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const ancestors = await schemeHeadNodeService.getSchemeHeadAncestors(id);
  sendSuccess(res, ancestors);
}

export async function createSchemeHeadNode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateSchemeHeadNodeInput;
  const context = getActorContext(req);
  const node = await schemeHeadNodeService.createSchemeHeadNode(body, context);
  sendSuccess(res, node, { statusCode: 201, message: "Scheme/Head node created." });
}

export async function updateSchemeHeadNode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateSchemeHeadNodeInput;
  const context = getActorContext(req);
  const node = await schemeHeadNodeService.updateSchemeHeadNode(id, body, context);
  sendSuccess(res, node, { message: "Scheme/Head node updated." });
}

export async function updateSchemeHeadNodeStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: FmsStatus };
  const context = getActorContext(req);
  const node = await schemeHeadNodeService.updateSchemeHeadNodeStatus(id, status, context);
  sendSuccess(res, node, { message: `Scheme/Head node ${status === "Active" ? "activated" : "deactivated"}.` });
}

export async function deleteSchemeHeadNode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  await schemeHeadNodeService.deleteSchemeHeadNode(id, context);
  sendSuccess(res, null, { message: "Scheme/Head node deleted." });
}
