import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";

/**
 * The scope resolves which Budget Setups get pooled together (see
 * reserveFromScope in budget-allocation.service.ts) — every ACTIVE Budget
 * Setup matching this exact (financialYearId, organizationRootNodeId,
 * schemeHeadRootNodeId) triple is treated as one combined fund. The client
 * sends the scope, not a specific Budget Setup id, since there may be more
 * than one for the same scope.
 */
const budgetAllocationScopeSchema = z.object({
  financialYearId: objectIdSchema,
  organizationRootNodeId: objectIdSchema,
  schemeHeadRootNodeId: objectIdSchema,
});

/**
 * headId is intentionally NOT validated as required here — whether it's
 * mandatory depends on the live Configuration Settings value at submit
 * time, which only the service layer can resolve (see spec §4: never trust
 * a frontend-supplied requireHead flag). The service throws its own 422 if
 * Require Head is on and headId is missing.
 */
export const createBudgetAllocationSchema = budgetAllocationScopeSchema.extend({
  organizationNodeId: objectIdSchema,
  headId: objectIdSchema.nullable().optional(),
  amount: z.number().positive("Amount must be greater than 0."),
  remarks: z.string().trim().max(1000).optional(),
});

export const BUDGET_ALLOCATION_SORT_KEYS = [
  "createdAt",
  "amount",
  "organizationNode",
  "head",
  "financialYear",
] as const;

export const budgetAllocationListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  financialYearId: objectIdSchema.optional(),
  organizationRootNodeId: objectIdSchema.optional(),
  schemeHeadRootNodeId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  headId: objectIdSchema.optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(BUDGET_ALLOCATION_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const budgetAllocationExportQuerySchema = budgetAllocationListQuerySchema.omit({
  page: true,
  limit: true,
});

/** One department's row in a bulk allocation submission — see createBulkBudgetAllocationsSchema. */
const bulkBudgetAllocationRowSchema = z.object({
  organizationNodeId: objectIdSchema,
  headId: objectIdSchema.nullable().optional(),
  amount: z.number().positive("Amount must be greater than 0."),
});

/**
 * Multiple departments allocated from the same pooled scope in one
 * submission (bulk allocation form) — one shared remarks field for the
 * whole batch, per-row Head since different departments in the same batch
 * can be attributed to different Heads. Each row is reserved against the
 * pool independently and in order, so an earlier row in the same batch can
 * exhaust one Budget Setup and spill into the next before a later row runs.
 */
export const createBulkBudgetAllocationsSchema = budgetAllocationScopeSchema.extend({
  rows: z.array(bulkBudgetAllocationRowSchema).min(1, "Select at least one department.").max(200),
  remarks: z.string().trim().max(1000).optional(),
});

export const budgetAllocationNodeTotalsQuerySchema = budgetAllocationScopeSchema;

/**
 * The non-file part of the "attach a Reference Document to a whole bulk
 * batch" request — arrives as a JSON-encoded string in a multipart form
 * field (it travels alongside the uploaded file, so it can't be the raw
 * JSON body), parsed in the controller before this validates it.
 */
export const attachBudgetAllocationDocumentSchema = z.object({
  allocationIds: z.array(objectIdSchema).min(1, "No allocations to attach the document to."),
});

export type CreateBudgetAllocationInput = z.infer<typeof createBudgetAllocationSchema>;
export type BudgetAllocationListQuery = z.infer<typeof budgetAllocationListQuerySchema>;
export type BudgetAllocationExportQuery = z.infer<typeof budgetAllocationExportQuerySchema>;
export type CreateBulkBudgetAllocationsInput = z.infer<typeof createBulkBudgetAllocationsSchema>;
export type BudgetAllocationNodeTotalsQuery = z.infer<typeof budgetAllocationNodeTotalsQuerySchema>;
export type AttachBudgetAllocationDocumentInput = z.infer<typeof attachBudgetAllocationDocumentSchema>;
