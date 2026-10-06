import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { PAYROLL_MONTHS, PAYROLL_PAYMENT_STATUSES } from "../../models/fms/PayrollBatch";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";

const payrollDeductionInputSchema = z.object({
  deductionId: objectIdSchema,
  percentage: z.coerce.number().min(0).max(100).optional(),
  amount: z.coerce.number().min(0, "Deduction amount cannot be negative."),
});

const payrollEmployeeInputSchema = z.object({
  beneficiaryId: objectIdSchema,
  salaryAmount: z.coerce.number().positive("Salary Amount must be positive."),
  deductions: z.array(payrollDeductionInputSchema).max(50).optional().default([]),
});

export const createPayrollBatchSchema = z.object({
  financialYearId: objectIdSchema,
  organizationRootNodeId: objectIdSchema,
  organizationNodeId: objectIdSchema,
  schemeHeadRootNodeId: objectIdSchema,
  month: z.enum(PAYROLL_MONTHS),
  sanctionNumber: z.string().trim().max(60).optional(),
  sanctionDate: z.coerce.date().optional(),
  remarks: z.string().trim().max(1000).optional(),
  enrichment1: z.string().trim().max(200).optional(),
  enrichment2: z.string().trim().max(200).optional(),
  employees: z.array(payrollEmployeeInputSchema).min(1, "At least one Employee is required."),
});

export const PAYROLL_SORT_KEYS = ["createdAt", "totalNetSalary", "payrollNumber"] as const;

export const payrollListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  month: z.enum(PAYROLL_MONTHS).optional(),
  schemeHeadRootNodeId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  financialYearId: objectIdSchema.optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  paymentStatus: z.enum(PAYROLL_PAYMENT_STATUSES).optional(),
  maker: objectIdSchema.optional(),
  verifier: objectIdSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  amountFrom: z.coerce.number().min(0).optional(),
  amountTo: z.coerce.number().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(PAYROLL_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const payrollExportQuerySchema = payrollListQuerySchema.omit({ page: true, limit: true });

export const bulkWorkflowIdsSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(200),
  remarks: z.string().trim().max(1000).optional(),
});

export type CreatePayrollBatchInput = z.infer<typeof createPayrollBatchSchema>;
export type PayrollListQuery = z.infer<typeof payrollListQuerySchema>;
export type PayrollExportQuery = z.infer<typeof payrollExportQuerySchema>;
export type BulkWorkflowIdsInput = z.infer<typeof bulkWorkflowIdsSchema>;
