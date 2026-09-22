import { z } from "zod";
import { objectIdSchema } from "../common.schema";

export const schemeHeadNodeStatusEnum = z.enum(["Active", "Inactive"]);

export const createSchemeHeadNodeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(150),
  code: z
    .string()
    .trim()
    .min(2, "Code must be at least 2 characters.")
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "Code must contain only letters, numbers, hyphens, and underscores."),
  nodeTypeId: objectIdSchema,
  parentNodeId: objectIdSchema.nullable().optional(),
  description: z.string().trim().max(500).optional(),
  displayOrder: z.number().int("Display order must be a whole number.").min(0).optional().default(0),
  status: schemeHeadNodeStatusEnum.optional().default("Active"),
});

export const updateSchemeHeadNodeSchema = createSchemeHeadNodeSchema.partial();

export const updateSchemeHeadNodeStatusSchema = z.object({ status: schemeHeadNodeStatusEnum });

export const schemeHeadNodeListQuerySchema = z.object({
  search: z.string().trim().optional(),
  nodeTypeId: objectIdSchema.optional(),
  parentNodeId: objectIdSchema.optional(),
  status: schemeHeadNodeStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.string().default("displayOrder"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateSchemeHeadNodeInput = z.infer<typeof createSchemeHeadNodeSchema>;
export type UpdateSchemeHeadNodeInput = z.infer<typeof updateSchemeHeadNodeSchema>;
export type SchemeHeadNodeListQuery = z.infer<typeof schemeHeadNodeListQuerySchema>;
