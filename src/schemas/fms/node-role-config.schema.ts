import { z } from "zod";
import { objectIdSchema } from "../common.schema";

export const nodeRoleConfigStatusEnum = z.enum(["Active", "Inactive"]);

export const createNodeRoleConfigSchema = z.object({
  node: objectIdSchema,
  makerEnabled: z.boolean().optional().default(false),
  verifierEnabled: z.boolean().optional().default(false),
  checkerEnabled: z.boolean().optional().default(false),
  status: nodeRoleConfigStatusEnum.optional(),
});

export const updateNodeRoleConfigSchema = z.object({
  makerEnabled: z.boolean().optional(),
  verifierEnabled: z.boolean().optional(),
  checkerEnabled: z.boolean().optional(),
  status: nodeRoleConfigStatusEnum.optional(),
});

export const nodeRoleConfigListQuerySchema = z.object({
  status: nodeRoleConfigStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const nodeIdRouteParamsSchema = z.object({ nodeId: objectIdSchema });

export type CreateNodeRoleConfigInput = z.infer<typeof createNodeRoleConfigSchema>;
export type UpdateNodeRoleConfigInput = z.infer<typeof updateNodeRoleConfigSchema>;
export type NodeRoleConfigListQuery = z.infer<typeof nodeRoleConfigListQuerySchema>;
