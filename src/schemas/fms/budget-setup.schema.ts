import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";

export const budgetSetupDocumentParamsSchema = z.object({
  id: objectIdSchema,
  documentId: objectIdSchema,
});

export const createBudgetSetupSchema = z.object({
  // Optional: omitted means "the current Financial Year" (spec §4/§19 —
  // never left to the frontend to guess, resolved server-side).
  financialYearId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema,
  schemeHeadNodeId: objectIdSchema,
  originalAmount: z.number().positive("Original amount must be greater than 0."),
  remarks: z.string().trim().max(1000).optional(),
});

export const updateBudgetSetupSchema = z.object({
  // Scope (year / org root / scheme-head root) is immutable after creation —
  // changing it once allocations may exist against the pool would silently
  // orphan or misattribute those allocations.
  originalAmount: z.number().positive("Original amount must be greater than 0.").optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export const updateBudgetSetupStatusSchema = z.object({
  status: z.enum(["Active", "Inactive"]),
});

/**
 * The public sort keys a caller may ask for — mapped to their actual Mongo
 * field/path server-side (see SORT_FIELD_MAP in budget-setup.service.ts) so
 * the query API stays clean while internally some are dotted paths into
 * looked-up documents or computed fields.
 */
export const BUDGET_SETUP_SORT_KEYS = [
  "createdAt",
  "financialYear",
  "organizationNode",
  "schemeHeadNode",
  "originalAmount",
  "allocatedAmount",
  "remainingAmount",
  "status",
] as const;

export const budgetSetupListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  financialYearId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  schemeHeadNodeId: objectIdSchema.optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(BUDGET_SETUP_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/** Same filters as the list, without pagination — used by the CSV export. */
export const budgetSetupExportQuerySchema = budgetSetupListQuerySchema.omit({ page: true, limit: true });

export type CreateBudgetSetupInput = z.infer<typeof createBudgetSetupSchema>;
export type UpdateBudgetSetupInput = z.infer<typeof updateBudgetSetupSchema>;
export type UpdateBudgetSetupStatusInput = z.infer<typeof updateBudgetSetupStatusSchema>;
export type BudgetSetupListQuery = z.infer<typeof budgetSetupListQuerySchema>;
export type BudgetSetupExportQuery = z.infer<typeof budgetSetupExportQuerySchema>;
