import mongoose, { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { NodeTypeModel } from "../../models/NodeType";
import { SchemeHeadNodeModel, type SchemeHeadNodeDocument, type FmsStatus } from "../../models/SchemeHeadNode";
import type {
  CreateSchemeHeadNodeInput,
  SchemeHeadNodeListQuery,
  UpdateSchemeHeadNodeInput,
} from "../../schemas/fms/scheme-head-node.schema";

interface ActorContext {
  actorId: Types.ObjectId | null;
  ipAddress: string | null;
  userAgent?: string | null;
}

interface NodeTypeRef {
  _id: string;
  name: string;
  code: string;
}

interface NodeRef {
  _id: string;
  name: string;
}

export interface SchemeHeadNodeDto {
  _id: string;
  name: string;
  code: string;
  nodeCategory: "SCHEME_HEAD";
  nodeTypeId: string;
  nodeType: NodeTypeRef | null;
  parentNodeId: string | null;
  parentNode: NodeRef | null;
  hierarchyPath: string;
  level: number;
  description?: string;
  status: FmsStatus;
  displayOrder: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchemeHeadTreeNode extends SchemeHeadNodeDto {
  children: SchemeHeadTreeNode[];
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** Escapes a string for safe use inside a RegExp constructor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The path prefix every descendant of `node` will have in their own hierarchyPath. */
function fullPathOf(node: Pick<SchemeHeadNodeDocument, "hierarchyPath" | "_id">): string {
  return `${node.hierarchyPath}${String(node._id)}/`;
}

async function buildLookupMaps() {
  const [nodeTypes, nodes] = await Promise.all([
    NodeTypeModel.find().select("name code").lean(),
    SchemeHeadNodeModel.find().select("name").lean(),
  ]);

  const nodeTypeMap = new Map<string, NodeTypeRef>(
    nodeTypes.map((nt) => [String(nt._id), { _id: String(nt._id), name: nt.name, code: nt.code }])
  );
  const nodeMap = new Map<string, NodeRef>(
    nodes.map((n) => [String(n._id), { _id: String(n._id), name: n.name }])
  );

  return { nodeTypeMap, nodeMap };
}

function serialize(
  node: SchemeHeadNodeDocument,
  nodeTypeMap: Map<string, NodeTypeRef>,
  nodeMap: Map<string, NodeRef>
): SchemeHeadNodeDto {
  const parentId = node.parentNodeId ? String(node.parentNodeId) : null;

  return {
    _id: String(node._id),
    name: node.name,
    code: node.code,
    nodeCategory: "SCHEME_HEAD",
    nodeTypeId: String(node.nodeTypeId),
    nodeType: nodeTypeMap.get(String(node.nodeTypeId)) ?? null,
    parentNodeId: parentId,
    parentNode: parentId ? (nodeMap.get(parentId) ?? null) : null,
    hierarchyPath: node.hierarchyPath,
    level: node.level,
    description: node.description,
    status: node.status,
    displayOrder: node.displayOrder,
    createdBy: node.createdBy ? String(node.createdBy) : null,
    updatedBy: node.updatedBy ? String(node.updatedBy) : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

async function findByIdOr404(id: string): Promise<SchemeHeadNodeDocument> {
  const node = await SchemeHeadNodeModel.findById(id);
  if (!node) throw new AppError(404, "Scheme/Head node not found.");
  return node;
}

async function assertNodeTypeIsSchemeHead(nodeTypeId: string): Promise<void> {
  const nodeType = await NodeTypeModel.findById(nodeTypeId);
  if (!nodeType) {
    throw new AppError(422, "The selected node type does not exist.", {
      nodeTypeId: ["Node type not found."],
    });
  }
  if (nodeType.nodeCategory !== "SCHEME_HEAD") {
    throw new AppError(422, `"${nodeType.name}" is not a Scheme/Head label.`, {
      nodeTypeId: ["Selected node type must belong to the Scheme/Head category."],
    });
  }
}

async function assertParentIsValid(parentNodeId: string): Promise<SchemeHeadNodeDocument> {
  const parent = await SchemeHeadNodeModel.findById(parentNodeId);
  if (!parent) {
    throw new AppError(422, "The selected parent node does not exist.", {
      parentNodeId: ["Parent node not found."],
    });
  }
  if (parent.status !== "Active") {
    throw new AppError(422, "The selected parent node is inactive.", {
      parentNodeId: ["Parent node must be active."],
    });
  }
  return parent;
}

/** True if `candidateId` is `node` itself or lies within its own subtree. */
async function isSelfOrDescendant(candidateId: string, node: SchemeHeadNodeDocument): Promise<boolean> {
  if (candidateId === String(node._id)) return true;
  const candidate = await SchemeHeadNodeModel.findById(candidateId).select("hierarchyPath");
  if (!candidate) return false;
  return candidate.hierarchyPath.startsWith(fullPathOf(node));
}

export async function listSchemeHeadNodes(
  query: SchemeHeadNodeListQuery
): Promise<ListResult<SchemeHeadNodeDto>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.nodeTypeId) filter.nodeTypeId = query.nodeTypeId;
  if (query.parentNodeId) filter.parentNodeId = query.parentNodeId;
  if (query.search) {
    filter.$or = [
      { name: { $regex: query.search, $options: "i" } },
      { code: { $regex: query.search, $options: "i" } },
    ];
  }

  const [docs, total, { nodeTypeMap, nodeMap }] = await Promise.all([
    SchemeHeadNodeModel.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SchemeHeadNodeModel.countDocuments(filter),
    buildLookupMaps(),
  ]);

  return {
    items: docs.map((doc) => serialize(doc, nodeTypeMap, nodeMap)),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

export async function getSchemeHeadNodeById(id: string): Promise<SchemeHeadNodeDto> {
  const node = await findByIdOr404(id);
  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  return serialize(node, nodeTypeMap, nodeMap);
}

export async function createSchemeHeadNode(
  input: CreateSchemeHeadNodeInput,
  context: ActorContext
): Promise<SchemeHeadNodeDto> {
  await assertNodeTypeIsSchemeHead(input.nodeTypeId);

  let hierarchyPath = "/";
  let level = 0;
  if (input.parentNodeId) {
    const parent = await assertParentIsValid(input.parentNodeId);
    hierarchyPath = fullPathOf(parent);
    level = parent.level + 1;
  }

  const created = await SchemeHeadNodeModel.create({
    name: input.name,
    code: input.code,
    nodeTypeId: input.nodeTypeId,
    parentNodeId: input.parentNodeId ?? null,
    hierarchyPath,
    level,
    description: input.description,
    status: input.status ?? "Active",
    displayOrder: input.displayOrder ?? 0,
    createdBy: context.actorId,
    updatedBy: context.actorId,
  });

  await logActivity({
    user: context.actorId,
    action: "SCHEME_HEAD_CREATED",
    module: "MASTER_DATA",
    description: `Created scheme/head node "${created.name}" (${created.code}).`,
    entityType: "SchemeHeadNode",
    entityId: created._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  return serialize(created, nodeTypeMap, nodeMap);
}

/**
 * Re-parents `node` under `newParentId` (or to root when null), cascading
 * the hierarchyPath/level change to every descendant inside one transaction
 * so the tree is never left half-updated.
 */
async function reparent(
  node: SchemeHeadNodeDocument,
  newParentId: string | null,
  context: ActorContext
): Promise<void> {
  const oldFullPath = fullPathOf(node);

  let newHierarchyPath = "/";
  let newLevel = 0;
  if (newParentId) {
    if (await isSelfOrDescendant(newParentId, node)) {
      throw new AppError(422, "Cannot move a node under itself or one of its own descendants.", {
        parentNodeId: ["Cannot move a node under itself or one of its own descendants."],
      });
    }
    const newParent = await assertParentIsValid(newParentId);
    newHierarchyPath = fullPathOf(newParent);
    newLevel = newParent.level + 1;
  }

  const levelDelta = newLevel - node.level;
  const newFullPath = `${newHierarchyPath}${String(node._id)}/`;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const descendants = await SchemeHeadNodeModel.find({
        hierarchyPath: { $regex: `^${escapeRegex(oldFullPath)}` },
      })
        .select("_id hierarchyPath level")
        .session(session);

      if (descendants.length > 0) {
        const bulkOps = descendants.map((descendant) => ({
          updateOne: {
            filter: { _id: descendant._id },
            update: {
              $set: {
                hierarchyPath: newFullPath + descendant.hierarchyPath.slice(oldFullPath.length),
                level: descendant.level + levelDelta,
              },
            },
          },
        }));
        await SchemeHeadNodeModel.bulkWrite(bulkOps, { session });
      }

      node.parentNodeId = newParentId ? new Types.ObjectId(newParentId) : null;
      node.hierarchyPath = newHierarchyPath;
      node.level = newLevel;
      node.updatedBy = context.actorId;
      await node.save({ session });
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    user: context.actorId,
    action: "SCHEME_HEAD_HIERARCHY_CHANGED",
    module: "MASTER_DATA",
    description: `Moved scheme/head node "${node.name}" to a new parent.`,
    entityType: "SchemeHeadNode",
    entityId: node._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

export async function updateSchemeHeadNode(
  id: string,
  input: UpdateSchemeHeadNodeInput,
  context: ActorContext
): Promise<SchemeHeadNodeDto> {
  const node = await findByIdOr404(id);

  if (input.nodeTypeId !== undefined) await assertNodeTypeIsSchemeHead(input.nodeTypeId);

  const parentChanging =
    input.parentNodeId !== undefined && input.parentNodeId !== (node.parentNodeId ? String(node.parentNodeId) : null);

  if (parentChanging) {
    await reparent(node, input.parentNodeId ?? null, context);
  }

  const otherFieldsChanged =
    input.name !== undefined ||
    input.code !== undefined ||
    input.nodeTypeId !== undefined ||
    input.description !== undefined ||
    input.status !== undefined ||
    input.displayOrder !== undefined;

  if (input.name !== undefined) node.name = input.name;
  if (input.code !== undefined) node.code = input.code;
  if (input.nodeTypeId !== undefined) node.nodeTypeId = new Types.ObjectId(input.nodeTypeId);
  if (input.description !== undefined) node.description = input.description;
  if (input.status !== undefined) node.status = input.status;
  if (input.displayOrder !== undefined) node.displayOrder = input.displayOrder;

  if (otherFieldsChanged) {
    node.updatedBy = context.actorId;
    await node.save();

    await logActivity({
      user: context.actorId,
      action: "SCHEME_HEAD_UPDATED",
      module: "MASTER_DATA",
      description: `Updated scheme/head node "${node.name}".`,
      entityType: "SchemeHeadNode",
      entityId: node._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  return serialize(node, nodeTypeMap, nodeMap);
}

export async function updateSchemeHeadNodeStatus(
  id: string,
  status: FmsStatus,
  context: ActorContext
): Promise<SchemeHeadNodeDto> {
  const node = await findByIdOr404(id);

  if (node.status !== status) {
    node.status = status;
    node.updatedBy = context.actorId;
    await node.save();

    await logActivity({
      user: context.actorId,
      action: status === "Active" ? "SCHEME_HEAD_ACTIVATED" : "SCHEME_HEAD_DEACTIVATED",
      module: "MASTER_DATA",
      description: `Set scheme/head node "${node.name}" status to ${status}.`,
      entityType: "SchemeHeadNode",
      entityId: node._id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  const { nodeTypeMap, nodeMap } = await buildLookupMaps();
  return serialize(node, nodeTypeMap, nodeMap);
}

export async function deleteSchemeHeadNode(id: string, context: ActorContext): Promise<void> {
  const node = await findByIdOr404(id);

  const childCount = await SchemeHeadNodeModel.countDocuments({ parentNodeId: id });
  if (childCount > 0) {
    throw new AppError(
      409,
      `Cannot delete "${node.name}" — it has ${childCount} child node${childCount === 1 ? "" : "s"}. Move or delete them first.`
    );
  }

  // Budget/Fund Allocation dependency checks land here once those modules ship.

  await node.deleteOne();

  await logActivity({
    user: context.actorId,
    action: "SCHEME_HEAD_DEACTIVATED",
    module: "MASTER_DATA",
    description: `Deleted unreferenced scheme/head node "${node.name}".`,
    entityType: "SchemeHeadNode",
    entityId: node._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

export async function getSchemeHeadTree(): Promise<SchemeHeadTreeNode[]> {
  const [docs, { nodeTypeMap, nodeMap }] = await Promise.all([
    SchemeHeadNodeModel.find().sort({ displayOrder: 1, name: 1 }),
    buildLookupMaps(),
  ]);

  const byId = new Map<string, SchemeHeadTreeNode>();
  for (const doc of docs) {
    byId.set(String(doc._id), { ...serialize(doc, nodeTypeMap, nodeMap), children: [] });
  }

  const roots: SchemeHeadTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function getSchemeHeadChildren(id: string): Promise<SchemeHeadNodeDto[]> {
  await findByIdOr404(id);
  const [docs, { nodeTypeMap, nodeMap }] = await Promise.all([
    SchemeHeadNodeModel.find({ parentNodeId: id }).sort({ displayOrder: 1, name: 1 }),
    buildLookupMaps(),
  ]);
  return docs.map((doc) => serialize(doc, nodeTypeMap, nodeMap));
}

export async function getSchemeHeadAncestors(id: string): Promise<SchemeHeadNodeDto[]> {
  const node = await findByIdOr404(id);

  const ancestorIds = node.hierarchyPath.split("/").filter(Boolean);
  if (ancestorIds.length === 0) return [];

  const [docs, { nodeTypeMap, nodeMap }] = await Promise.all([
    SchemeHeadNodeModel.find({ _id: { $in: ancestorIds } }),
    buildLookupMaps(),
  ]);

  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  return ancestorIds.flatMap((ancestorId) => {
    const doc = byId.get(ancestorId);
    return doc ? [serialize(doc, nodeTypeMap, nodeMap)] : [];
  });
}
