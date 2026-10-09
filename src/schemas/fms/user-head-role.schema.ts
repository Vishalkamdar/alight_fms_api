import { z } from "zod";
import { objectIdSchema } from "../common.schema";

export const headAssignmentStatusEnum = z.enum(["Active", "Inactive"]);

export const createUserHeadRoleSchema = z.object({
  user: objectIdSchema,
  head: objectIdSchema,
  status: headAssignmentStatusEnum.optional(),
});

export const updateAssignmentStatusSchema = z.object({
  status: headAssignmentStatusEnum,
});

export const userHeadRoleListQuerySchema = z.object({
  user: objectIdSchema.optional(),
  head: objectIdSchema.optional(),
  status: headAssignmentStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().default("assignedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const userIdParamsSchema = z.object({ userId: objectIdSchema });

export type CreateUserHeadRoleInput = z.infer<typeof createUserHeadRoleSchema>;
export type UpdateHeadAssignmentStatusInput = z.infer<typeof updateAssignmentStatusSchema>;
export type UserHeadRoleListQuery = z.infer<typeof userHeadRoleListQuerySchema>;
