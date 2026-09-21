import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { recordAudit } from "../../utils/fms/audit-log";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import {
  FmsNodeRoleConfigModel,
  FmsNodeRoleConfigDocument,
} from "../../models/fms/FmsNodeRoleConfig";
import type {
  CreateNodeRoleConfigInput,
  NodeRoleConfigListQuery,
  UpdateNodeRoleConfigInput,
} from "../../schemas/fms/node-role-config.schema";

async function assertNodeExistsAndActive(nodeId: string) {
  const node = await OrganizationNodeModel.findById(nodeId);
  if (!node) {
    throw new AppError(404, "Organization node not found.", { node: ["Node not found."] });
  }
  if (node.status !== "Active") {
    throw new AppError(422, "This organization node is not active.", {
      node: ["Node is not active."],
    });
  }
  return node;
}

export async function createConfig(
  input: CreateNodeRoleConfigInput,
  actorId: Types.ObjectId,
  ipAddress: string | null
): Promise<FmsNodeRoleConfigDocument> {
  await assertNodeExistsAndActive(input.node);

  const existing = await FmsNodeRoleConfigModel.findOne({ node: input.node });
  if (existing) {
    throw new AppError(409, "A role configuration already exists for this node.", {
      node: ["Role configuration already exists — use PUT to update it."],
    });
  }

  const created = await FmsNodeRoleConfigModel.create({
    node: input.node,
    makerEnabled: input.makerEnabled,
    verifierEnabled: input.verifierEnabled,
    checkerEnabled: input.checkerEnabled,
    status: input.status ?? "Active",
    createdBy: actorId,
    updatedBy: actorId,
  });

  await recordAudit({
    user: actorId,
    action: "Node Role Configuration Created",
    entity: "FmsNodeRoleConfig",
    entityId: created._id,
    newValue: created.toObject(),
    ipAddress,
  });

  return created;
}

export async function updateConfig(
  nodeId: string,
  input: UpdateNodeRoleConfigInput,
  actorId: Types.ObjectId,
  ipAddress: string | null
): Promise<FmsNodeRoleConfigDocument> {
  const config = await FmsNodeRoleConfigModel.findOne({ node: nodeId });
  if (!config) {
    throw new AppError(404, "No role configuration exists for this node yet.");
  }

  const previousValue = config.toObject();

  if (input.makerEnabled !== undefined) config.makerEnabled = input.makerEnabled;
  if (input.verifierEnabled !== undefined) config.verifierEnabled = input.verifierEnabled;
  if (input.checkerEnabled !== undefined) config.checkerEnabled = input.checkerEnabled;
  if (input.status !== undefined) config.status = input.status;
  config.updatedBy = actorId;

  await config.save();

  await recordAudit({
    user: actorId,
    action: "Node Role Configuration Updated",
    entity: "FmsNodeRoleConfig",
    entityId: config._id,
    previousValue,
    newValue: config.toObject(),
    ipAddress,
  });

  return config;
}

export async function getConfigByNode(nodeId: string): Promise<FmsNodeRoleConfigDocument> {
  const config = await FmsNodeRoleConfigModel.findOne({ node: nodeId });
  if (!config) {
    throw new AppError(404, "No role configuration exists for this node yet.");
  }
  return config;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export async function listConfigs(
  query: NodeRoleConfigListQuery
): Promise<ListResult<FmsNodeRoleConfigDocument>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    FmsNodeRoleConfigModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FmsNodeRoleConfigModel.countDocuments(filter),
  ]);

  return {
    items,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}
