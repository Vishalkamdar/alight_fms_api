import { Response } from "express";
import { NodeTypeModel } from "../models/NodeType";
import { OrganizationNodeModel } from "../models/OrganizationNode";
import { AppError } from "../utils/AppError";
import { sendSuccess } from "../utils/apiResponse";
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
  const { search, status, page, limit, sortBy, sortOrder } = res.locals.query as NodeTypeListQuery;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
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

  sendSuccess(res, nodeType, { statusCode: 201, message: "Node type created." });
}

export async function updateNodeType(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateNodeTypeInput;

  const nodeType = await findNodeTypeOr404(id);
  nodeType.set(body);
  nodeType.updatedBy = req.user?._id ?? null;
  await nodeType.save();

  sendSuccess(res, nodeType, { message: "Node type updated." });
}

export async function updateNodeTypeStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: "Active" | "Inactive" };

  const nodeType = await findNodeTypeOr404(id);
  nodeType.status = status;
  nodeType.updatedBy = req.user?._id ?? null;
  await nodeType.save();

  sendSuccess(res, nodeType);
}

export async function deleteNodeType(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const nodeType = await findNodeTypeOr404(id);

  const inUseCount = await OrganizationNodeModel.countDocuments({ nodeTypeId: id });
  if (inUseCount > 0) {
    throw new AppError(
      409,
      `Cannot delete "${nodeType.name}" — it is used by ${inUseCount} organization node${
        inUseCount === 1 ? "" : "s"
      }.`
    );
  }

  await nodeType.deleteOne();
  sendSuccess(res, null, { message: "Node type deleted." });
}
