import { z } from "zod";
import { objectIdSchema } from "./common.schema";

export const organizationNodeStatusEnum = z.enum(["Active", "Inactive"]);

export const createOrganizationNodeSchema = z.object({
  name: z.string().trim().min(2, "Node name must be at least 2 characters.").max(150),
  nodeTypeId: objectIdSchema,
  parentNodeId: objectIdSchema.nullable(),
  displayOrder: z.number().int("Display order must be a whole number.").min(0),
  status: organizationNodeStatusEnum,
});

export const updateOrganizationNodeSchema = createOrganizationNodeSchema.partial();

export const updateOrganizationNodeStatusSchema = z.object({ status: organizationNodeStatusEnum });

export const moveOrganizationNodeSchema = z.object({ parentNodeId: objectIdSchema.nullable() });

export const reorderOrganizationNodeSchema = z.object({
  displayOrder: z.number().int("Display order must be a whole number.").min(0),
});

export const organizationNodeListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: organizationNodeStatusEnum.optional(),
  nodeTypeId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(10),
  sortBy: z.string().default("displayOrder"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateOrganizationNodeInput = z.infer<typeof createOrganizationNodeSchema>;
export type UpdateOrganizationNodeInput = z.infer<typeof updateOrganizationNodeSchema>;
export type OrganizationNodeListQuery = z.infer<typeof organizationNodeListQuerySchema>;
