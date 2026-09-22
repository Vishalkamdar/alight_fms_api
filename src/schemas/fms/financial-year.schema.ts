import { z } from "zod";
import { FINANCIAL_YEAR_STATUSES } from "../../models/fms/FinancialYear";

/**
 * Creation takes only the starting calendar year (e.g. 2027 → "2027-28",
 * 01-Apr-2027 → 31-Mar-2028) — never a raw date range — so it is
 * structurally impossible to create a Financial Year that doesn't run
 * 1 April → 31 March.
 */
export const createFinancialYearSchema = z.object({
  startYear: z.number().int("Start year must be a whole number.").min(2000).max(2100),
});

/** Corrects a mistakenly-created year before it's relied upon. Closed years reject this entirely. */
export const updateFinancialYearSchema = z.object({
  startYear: z.number().int("Start year must be a whole number.").min(2000).max(2100).optional(),
});

export const updateFinancialYearStatusSchema = z.object({
  status: z.enum(FINANCIAL_YEAR_STATUSES),
});

export const enablePreviousYearEntrySchema = z.object({
  enabled: z.boolean().optional().default(true),
});

export const closeBooksSchema = z.object({
  // Explicit confirmation flag — a GET-style "just check" call to the same
  // validation happens via closing-summary; this endpoint only performs the
  // actual close once the caller has reviewed that summary and confirmed.
  confirm: z.boolean().refine((value) => value === true, {
    message: "Closing must be explicitly confirmed.",
  }),
});

export const reopenFinancialYearSchema = z.object({
  reason: z.string().trim().min(5, "A reason is required to reopen a Financial Year.").max(1000),
});

export const financialYearListQuerySchema = z.object({
  status: z.enum(FINANCIAL_YEAR_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.string().default("startDate"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateFinancialYearInput = z.infer<typeof createFinancialYearSchema>;
export type UpdateFinancialYearInput = z.infer<typeof updateFinancialYearSchema>;
export type EnablePreviousYearEntryInput = z.infer<typeof enablePreviousYearEntrySchema>;
export type CloseBooksInput = z.infer<typeof closeBooksSchema>;
export type ReopenFinancialYearInput = z.infer<typeof reopenFinancialYearSchema>;
export type FinancialYearListQuery = z.infer<typeof financialYearListQuerySchema>;
