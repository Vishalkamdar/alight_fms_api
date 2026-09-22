import { z } from "zod";
import { ACTIVITY_MODULES, ACTIVITY_STATUSES } from "../models/UserActivityLog";
import { objectIdSchema } from "./common.schema";

export const activityLogListQuerySchema = z.object({
  user: objectIdSchema.optional(),
  module: z.enum(ACTIVITY_MODULES).optional(),
  action: z.string().trim().optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  ipAddress: z.string().trim().optional(),
  entityType: z.string().trim().optional(),
  entityId: z.string().trim().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type ActivityLogListQuery = z.infer<typeof activityLogListQuerySchema>;
