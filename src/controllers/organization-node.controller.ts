import { Response } from "express";
import { Types } from "mongoose";
import { NodeTypeModel } from "../models/NodeType";
import { OrganizationNodeModel, OrganizationNodeDocument } from "../models/OrganizationNode";
import { AppError } from "../utils/AppError";
import { sendSuccess } from "../utils/apiResponse";
import type { AuthenticatedRequest } from "../middleware/auth";
import type {
  CreateOrganizationNodeInput,
  OrganizationNodeListQuery,
  UpdateOrganizationNodeInput,
} from "../schemas/organization-node.schema";

interface NodeTypeRef {
  _id: string;
  name: string;
  code: string;
}

interface NodeRef {
  _id: string;
  name: string;
}

async function findNodeOr404(id: string) {
  const node = await OrganizationNodeModel.findById(id);
  if (!node) throw new AppError(404, "Organization node not found.");
  return node;
}

async function buildLookupMaps() {
  const [nodeTypes, nodes] = await Promise.all([
    NodeTypeModel.find().select("name code").lean(),
    OrganizationNodeModel.find().select("name").lean(),
  ]);

  const nodeTypeMap = new Map<string, NodeTypeRef>(
    nodeTypes.map((nt) => [String(nt._id), { _id: String(nt._id), name: nt.name, code: nt.code }])
  );
  const nodeMap = new Map<string, NodeRef>(
    nodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])
  );

  return { nodeTypeMap, nodeMap };
}

function serializeNode(
  node: OrganizationNodeDocument,
  nodeTypeMap: Map<string, NodeTypeRef>,
  nodeMap: Map<string, NodeRef>
) {
  const parentId = node.parentNodeId ? String(node.parentNodeId) : null;

  return {
    _id: String(node._id),
    name: node.name,
    nodeTypeId: String(node.nodeTypeId),
    nodeType: nodeTypeMap.get(String(node.nodeTypeId)) ?? null,
    parentNodeId: parentId,
    parentNode: parentId ? (nodeMap.get(parentId) ?? null) : null,
    status: node.status,
    displayOrder: node.displayOrder,
    createdBy: node.createdBy ? String(node.createdBy) : null,
    updatedBy: node.updatedBy ? String(node.updatedBy) : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

async function assertNodeTypeExists(nodeTypeId: string): Promise<void> {
  const exists = await NodeTypeModel.exists({ _id: nodeTypeId });
  if (!exists) {
    throw new AppError(422, "The selected node type does not exist.", {
      nodeTypeId: ["Node type not found."],
    });
  }
}

async function assertParentExists(parentNodeId: string | null): Promise<void> {
  if (!parentNodeId) return;
  const exists = await OrganizationNodeModel.exists({ _id: parentNodeId });
  if (!exists) {
    throw new AppError(422, "The selected parent node does not exist.", {
      parentNodeId: ["Parent node not found."],
    });
  }
}

/** True if `candidateId` is `ancestorId` itself or lies beneath it in the tree. */
async function isNodeOrDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
  let currentId: string | null = candidateId;
  const visited = new Set<string>();

  while (currentId) {
    if (currentId === ancestorId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const current: OrganizationNodeDocument | null = await OrganizationNodeModel.findById(currentId);
    currentId = current?.parentNodeId ? String(current.parentNodeId) : null;
  }

  return false;
}

async function assertValidParentAssignment(nodeId: string, parentNodeId: string | null): Promise<void> {
  if (!parentNodeId) return;

  if (parentNodeId === nodeId) {
    throw new AppError(422, "A node cannot be its own parent.", {
      parentNodeId: ["A node cannot be its own parent."],
    });
  }

  await assertParentExists(parentNodeId);

  if (await isNodeOrDescendant(parentNodeId, nodeId)) {
    throw new AppError(422, "Cannot move a node under its own descendant.", {
      parentNodeId: ["Cannot move a node under its own descendant."],
    });
  }
}

export async function listOrganizationNodes(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { search, status, nodeTypeId, page, limit, sortBy, sortOrder } =
    res.locals.query as OrganizationNodeListQuery;

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (nodeTypeId) filter.nodeTypeId = nodeTypeId;
  if (search) filter.name = { $regex: search, $options: "i" };

  const [docs, total, { nodeTypeMap, nodeMap }] = await Promise.all([
    OrganizationNodeModel.find(filter)
      .sort({ [sortBy]: sortOrder === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    OrganizationNodeModel.countDocuments(filter),
    buildLookupMaps(),
  ]);

  const items = docs.map((doc) => serializeNode(doc, nodeTypeMap, nodeMap));

  sendSuccess(res, items, {
    meta: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}

export async function getOrganizationTree(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const [docs, { nodeTypeMap, nodeMap }] = await Promise.all([
    OrganizationNodeModel.find().sort({ displayOrder: 1, name: 1 }),
    buildLookupMaps(),
  ]);

  type TreeNode = ReturnType<typeof serializeNode> & { children: TreeNode[] };

  const byId = new Map<string, TreeNode>();
  for (const doc of docs) {
    byId.set(String(doc._id), { ...serializeNode(doc, nodeTypeMap, nodeMap), children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sendSuccess(res, roots);
}

export async function getOrganizationNode(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const node = await findNodeOr404(id);
  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap));
}

export async function createOrganizationNode(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const body = res.locals.body as CreateOrganizationNodeInput;

  await assertNodeTypeExists(body.nodeTypeId);
  await assertParentExists(body.parentNodeId);

  const node = await OrganizationNodeModel.create({
    ...body,
    createdBy: req.user?._id ?? null,
    updatedBy: req.user?._id ?? null,
  });

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap), {
    statusCode: 201,
    message: "Node created.",
  });
}

export async function updateOrganizationNode(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateOrganizationNodeInput;

  const node = await findNodeOr404(id);

  if (body.nodeTypeId) await assertNodeTypeExists(body.nodeTypeId);
  if (body.parentNodeId !== undefined) await assertValidParentAssignment(id, body.parentNodeId);

  node.set(body);
  node.updatedBy = req.user?._id ?? null;
  await node.save();

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap), { message: "Node updated." });
}

export async function updateOrganizationNodeStatus(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: "Active" | "Inactive" };

  const node = await findNodeOr404(id);
  node.status = status;
  node.updatedBy = req.user?._id ?? null;
  await node.save();

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap));
}

export async function moveOrganizationNode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { parentNodeId } = res.locals.body as { parentNodeId: string | null };

  const node = await findNodeOr404(id);
  await assertValidParentAssignment(id, parentNodeId);

  node.parentNodeId = parentNodeId ? new Types.ObjectId(parentNodeId) : null;
  node.updatedBy = req.user?._id ?? null;
  await node.save();

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap), { message: "Node moved." });
}

export async function reorderOrganizationNode(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { displayOrder } = res.locals.body as { displayOrder: number };

  const node = await findNodeOr404(id);
  node.displayOrder = displayOrder;
  node.updatedBy = req.user?._id ?? null;
  await node.save();

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  sendSuccess(res, serializeNode(node, nodeTypeMap, nodeMap));
}

export async function deleteOrganizationNode(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const node = await findNodeOr404(id);

  const childCount = await OrganizationNodeModel.countDocuments({ parentNodeId: id });
  if (childCount > 0) {
    throw new AppError(
      409,
      `Cannot delete "${node.name}" — it has ${childCount} child node${
        childCount === 1 ? "" : "s"
      }. Move or delete them first.`
    );
  }

  // Budget/Fund/Invoice/Payment dependency checks land here as those
  // modules ship, before deletion is ever allowed to proceed.

  await node.deleteOne();
  sendSuccess(res, null, { message: "Node deleted." });
}
