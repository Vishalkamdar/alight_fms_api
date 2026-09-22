import { Response } from "express";
import { NodeTypeModel } from "../models/NodeType";
import { OrganizationNodeModel } from "../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../models/SchemeHeadNode";
import { AppError } from "../utils/AppError";
import { sendSuccess } from "../utils/apiResponse";
import { logActivity } from "../utils/activity-log";
import type { AuthenticatedRequest } from "../middleware/auth";
import type {
  CreateNodeTypeInput,
  NodeTypeListQuery,
  UpdateNodeTypeInput,
} from "../schemas/node-type.schema";

async function findNodeTypeOr404(id: string) {
  const nodeType = await NodeTypeModel.findById(id);
  if (!nodeType) throw new AppError(404, "Node type not found.");
  return nodeType;
}

export async function listNodeTypes(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { search, status, nodeCategory, page, limit, sortBy, sortOrder } =
    res.locals.query as NodeTypeListQuery;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (nodeCategory) filter.nodeCategory = nodeCategory;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { code: { $regex: search, $options: "i" } },
    ];
  }

  const [items, total] = await Promise.all([
    NodeTypeModel.find(filter)
      .sort({ [sortBy]: sortOrder === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    NodeTypeModel.countDocuments(filter),
  ]);

  sendSuccess(res, items, {
    meta: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}

export async function getNodeType(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const nodeType = await findNodeTypeOr404(id);
  sendSuccess(res, nodeType);
}

export async function createNodeType(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateNodeTypeInput;

  const nodeType = await NodeTypeModel.create({
    ...body,
    createdBy: req.user?._id ?? null,
    updatedBy: req.user?._id ?? null,
  });

  await logActivity({
    user: req.user?._id ?? null,
    action: "MASTER_DATA_CREATED",
    module: "MASTER_DATA",
    description: `Created node type "${nodeType.name}".`,
    entityType: "NodeType",
    entityId: nodeType._id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, nodeType, { statusCode: 201, message: "Node type created." });
}

export async function updateNodeType(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateNodeTypeInput;

  const nodeType = await findNodeTypeOr404(id);
  nodeType.set(body);
  nodeType.updatedBy = req.user?._id ?? null;
  await nodeType.save();

  await logActivity({
    user: req.user?._id ?? null,
    action: "MASTER_DATA_UPDATED",
    module: "MASTER_DATA",
    description: `Updated node type "${nodeType.name}".`,
    entityType: "NodeType",
    entityId: nodeType._id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, nodeType, { message: "Node type updated." });
}

export async function updateNodeTypeStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: "Active" | "Inactive" };

  const nodeType = await findNodeTypeOr404(id);
  nodeType.status = status;
  nodeType.updatedBy = req.user?._id ?? null;
  await nodeType.save();

  await logActivity({
    user: req.user?._id ?? null,
    action: status === "Inactive" ? "MASTER_DATA_DEACTIVATED" : "MASTER_DATA_UPDATED",
    module: "MASTER_DATA",
    description: `Set node type "${nodeType.name}" status to ${status}.`,
    entityType: "NodeType",
    entityId: nodeType._id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, nodeType);
}

export async function deleteNodeType(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const nodeType = await findNodeTypeOr404(id);

  const [organizationNodeCount, schemeHeadNodeCount] = await Promise.all([
    OrganizationNodeModel.countDocuments({ nodeTypeId: id }),
    SchemeHeadNodeModel.countDocuments({ nodeTypeId: id }),
  ]);
  const inUseCount = organizationNodeCount + schemeHeadNodeCount;
  if (inUseCount > 0) {
    throw new AppError(
      409,
      `Cannot delete "${nodeType.name}" — it is used by ${inUseCount} node${
        inUseCount === 1 ? "" : "s"
      }.`
    );
  }

  await nodeType.deleteOne();

  await logActivity({
    user: req.user?._id ?? null,
    action: "MASTER_DATA_DEACTIVATED",
    module: "MASTER_DATA",
    description: `Deleted unreferenced node type "${nodeType.name}".`,
    entityType: "NodeType",
    entityId: nodeType._id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  sendSuccess(res, null, { message: "Node type deleted." });
}
