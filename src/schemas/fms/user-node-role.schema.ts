import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { FMS_ROLES } from "../../models/fms/FmsUserNodeRole";

export const fmsRoleEnum = z.enum(FMS_ROLES);
export const assignmentStatusEnum = z.enum(["Active", "Inactive"]);

export const createUserNodeRoleSchema = z.object({
  user: objectIdSchema,
  node: objectIdSchema,
  role: fmsRoleEnum,
  status: assignmentStatusEnum.optional(),
});

export const updateUserNodeRoleSchema = z
  .object({
    role: fmsRoleEnum.optional(),
    status: assignmentStatusEnum.optional(),
  })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: "Provide at least role or status to update.",
  });

export const updateAssignmentStatusSchema = z.object({
  status: assignmentStatusEnum,
});

export const userNodeRoleListQuerySchema = z.object({
  user: objectIdSchema.optional(),
  node: objectIdSchema.optional(),
  role: fmsRoleEnum.optional(),
  status: assignmentStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().default("assignedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const nodeUsersQuerySchema = z.object({
  status: assignmentStatusEnum.optional(),
});

export const userIdParamsSchema = z.object({ userId: objectIdSchema });
export const nodeIdParamsSchema = z.object({ nodeId: objectIdSchema });

export type CreateUserNodeRoleInput = z.infer<typeof createUserNodeRoleSchema>;
export type UpdateUserNodeRoleInput = z.infer<typeof updateUserNodeRoleSchema>;
export type UserNodeRoleListQuery = z.infer<typeof userNodeRoleListQuerySchema>;
export type NodeUsersQuery = z.infer<typeof nodeUsersQuerySchema>;
