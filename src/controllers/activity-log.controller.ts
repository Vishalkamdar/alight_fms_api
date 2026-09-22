import { Response } from "express";
import { UserActivityLogModel } from "../models/UserActivityLog";
import { sendSuccess } from "../utils/apiResponse";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { ActivityLogListQuery } from "../schemas/activity-log.schema";

export async function listActivityLogs(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ActivityLogListQuery;

  const filter: Record<string, unknown> = {};
  if (query.user) filter.user = query.user;
  if (query.module) filter.module = query.module;
  if (query.action) filter.action = { $regex: query.action, $options: "i" };
  if (query.status) filter.status = query.status;
  if (query.ipAddress) filter.ipAddress = { $regex: query.ipAddress, $options: "i" };
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.dateFrom || query.dateTo) {
    const createdAt: Record<string, Date> = {};
    if (query.dateFrom) createdAt.$gte = query.dateFrom;
    if (query.dateTo) createdAt.$lte = query.dateTo;
    filter.createdAt = createdAt;
  }

  const [items, total] = await Promise.all([
    UserActivityLogModel.find(filter)
      .sort({ createdAt: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate("user", "fullname email")
      .lean(),
    UserActivityLogModel.countDocuments(filter),
  ]);

  sendSuccess(res, items, {
    message: "Activity logs retrieved successfully.",
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  });
}
