import { z } from "zod";
import { NODE_CATEGORIES } from "../models/NodeType";

export const nodeTypeStatusEnum = z.enum(["Active", "Inactive"]);
export const nodeCategoryEnum = z.enum(NODE_CATEGORIES);

export const createNodeTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  code: z
    .string()
    .trim()
    .min(2, "Code must be at least 2 characters.")
    .max(30)
    .regex(/^[A-Za-z0-9_]+$/, "Code must contain only letters, numbers, and underscores."),
  nodeCategory: nodeCategoryEnum.default("ORGANIZATION"),
  description: z.string().trim().max(500).optional(),
  displayOrder: z.number().int("Display order must be a whole number.").min(0),
  status: nodeTypeStatusEnum,
});

export const updateNodeTypeSchema = createNodeTypeSchema.partial();

export const updateNodeTypeStatusSchema = z.object({ status: nodeTypeStatusEnum });

export const nodeTypeListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: nodeTypeStatusEnum.optional(),
  nodeCategory: nodeCategoryEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(10),
  sortBy: z.string().default("displayOrder"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateNodeTypeInput = z.infer<typeof createNodeTypeSchema>;
export type UpdateNodeTypeInput = z.infer<typeof updateNodeTypeSchema>;
export type NodeTypeListQuery = z.infer<typeof nodeTypeListQuerySchema>;
