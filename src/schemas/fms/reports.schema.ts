import { z } from "zod";
import { objectIdSchema, objectIdParamsSchema } from "../common.schema";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";
import { BENEFICIARY_TYPES } from "../../models/fms/Beneficiary";

export const REPORT_MODULES = ["EXPENDITURE", "PAYROLL", "BUDGET_ALLOCATION", "BUDGET_SETUP"] as const;
export type ReportModule = (typeof REPORT_MODULES)[number];

/**
 * One shared filter surface every report schema below extends — "only
 * display filters relevant to that report" (spec §2) is enforced on the
 * FRONTEND (which filters only render the ones a given report declares),
 * not by narrowing this base per report; the backend is happy to ignore a
 * filter a particular report doesn't use. "Project" is intentionally
 * absent — no Project concept exists anywhere in this app, the same
 * standing decision made for Expenditure/Bulk Upload earlier.
 */
const reportBaseFields = {
  financialYearId: objectIdSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  organizationNodeId: objectIdSchema.optional(),
  organizationRootNodeId: objectIdSchema.optional(),
  schemeHeadRootNodeId: objectIdSchema.optional(),
  headId: objectIdSchema.optional(),
  module: z.enum(REPORT_MODULES).optional(),
  status: z.string().trim().max(60).optional(),
  userId: objectIdSchema.optional(),
  beneficiaryId: objectIdSchema.optional(),
  beneficiaryType: z.enum(BENEFICIARY_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().trim().max(60).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
};

export const reportFiltersSchema = z.object(reportBaseFields);
export const reportExportQuerySchema = reportFiltersSchema.extend({
  format: z.enum(["csv", "pdf"]).default("csv"),
});

export const financialYearSummaryQuerySchema = z.object({
  financialYearId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  format: z.enum(["csv", "pdf"]).default("csv"),
});

export const approvalStatusFiltersSchema = reportFiltersSchema.extend({
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
});
export const approvalStatusExportQuerySchema = approvalStatusFiltersSchema.extend({
  format: z.enum(["csv"]).default("csv"),
});

export const drilldownParamsSchema = objectIdParamsSchema;

export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;
export type FinancialYearSummaryQuery = z.infer<typeof financialYearSummaryQuerySchema>;
export type ApprovalStatusFilters = z.infer<typeof approvalStatusFiltersSchema>;
export type ApprovalStatusExportQuery = z.infer<typeof approvalStatusExportQuerySchema>;
