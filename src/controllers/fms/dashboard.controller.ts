import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import * as dashboardService from "../../services/fms/dashboard.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { DashboardQuery } from "../../schemas/fms/dashboard.schema";

export async function getDashboard(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as DashboardQuery;
  const context = getActorContextWithRole(req);
  const dashboard = await dashboardService.getDashboardData(query, context);
  sendSuccess(res, dashboard);
}
