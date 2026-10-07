import { z } from "zod";
import { objectIdSchema } from "../common.schema";

export const DASHBOARD_MODULES = ["EXPENDITURE", "PAYROLL", "BUDGET_ALLOCATION", "BUDGET_SETUP", "FUND_TRANSFER"] as const;
export type DashboardModule = (typeof DASHBOARD_MODULES)[number];

export const dashboardQuerySchema = z.object({
  financialYearId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  module: z.enum(DASHBOARD_MODULES).optional(),
  status: z.string().trim().max(60).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
