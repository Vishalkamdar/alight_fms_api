import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";
import { FUND_TRANSFER_TYPES } from "../../models/fms/FundTransfer";

/**
 * Both Pull and Return submit the same shape — sourceNodeId is always the
 * child (balance decreases), destinationNodeId is always the parent
 * (balance increases). Which ENDPOINT the client calls determines
 * transactionType and which side (source vs destination) the Maker
 * permission check runs against; the client never sends transactionType
 * itself (§11 — never trust a client-supplied field to decide authorization).
 */
export const createFundTransferSchema = z.object({
  financialYearId: objectIdSchema,
  organizationRootNodeId: objectIdSchema,
  schemeHeadRootNodeId: objectIdSchema,
  sourceNodeId: objectIdSchema,
  destinationNodeId: objectIdSchema,
  headId: objectIdSchema.nullable().optional(),
  amount: z.number().positive("Amount must be greater than 0."),
  reason: z.string().trim().min(1, "A reason is required.").max(1000),
  relatedBudgetAllocationId: objectIdSchema.nullable().optional(),
});

export const FUND_TRANSFER_SORT_KEYS = [
  "createdAt",
  "amount",
  "sourceNode",
  "destinationNode",
  "financialYear",
  "maker",
] as const;

export const fundTransferListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  transactionType: z.enum(FUND_TRANSFER_TYPES).optional(),
  financialYearId: objectIdSchema.optional(),
  organizationRootNodeId: objectIdSchema.optional(),
  schemeHeadRootNodeId: objectIdSchema.optional(),
  sourceNodeId: objectIdSchema.optional(),
  destinationNodeId: objectIdSchema.optional(),
  headId: objectIdSchema.optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  amountFrom: z.coerce.number().min(0).optional(),
  amountTo: z.coerce.number().min(0).optional(),
  maker: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(FUND_TRANSFER_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const fundTransferExportQuerySchema = fundTransferListQuerySchema.omit({ page: true, limit: true });

export const returnableAmountQuerySchema = z.object({
  nodeId: objectIdSchema,
  financialYearId: objectIdSchema,
  organizationRootNodeId: objectIdSchema,
  schemeHeadRootNodeId: objectIdSchema,
});

export const bulkFundTransferActionSchema = z.object({
  ids: z.array(objectIdSchema).min(1, "Select at least one transaction.").max(200),
  remarks: z.string().trim().max(1000).optional(),
});

export type CreateFundTransferInput = z.infer<typeof createFundTransferSchema>;
export type FundTransferListQuery = z.infer<typeof fundTransferListQuerySchema>;
export type FundTransferExportQuery = z.infer<typeof fundTransferExportQuerySchema>;
export type BulkFundTransferActionInput = z.infer<typeof bulkFundTransferActionSchema>;
export type ReturnableAmountQuery = z.infer<typeof returnableAmountQuerySchema>;
