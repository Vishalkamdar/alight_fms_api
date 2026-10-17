import { z } from "zod";
import { objectIdSchema } from "../common.schema";

/** Verifier/Checker approval actions — identical shape across every financial module. */
export const workflowVerifySchema = z.object({
  remarks: z.string().trim().max(1000).optional(),
});

export const workflowApproveSchema = z.object({
  remarks: z.string().trim().max(1000).optional(),
});

export const workflowRejectSchema = z.object({
  reason: z.string().trim().min(1, "A rejection reason is required.").max(1000),
});

/**
 * Bulk reject — one shared reason applied to every selected record, same
 * `ids` cap as each module's own bulk-verify/approve schema (duplicated
 * per module rather than shared, matching the existing convention — this
 * one stays shared since it reuses workflowRejectSchema's reason
 * validation rather than introducing a 5th copy of it).
 */
export const bulkWorkflowRejectSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(200),
  reason: z.string().trim().min(1, "A rejection reason is required.").max(1000),
});

export type WorkflowVerifyInput = z.infer<typeof workflowVerifySchema>;
export type WorkflowApproveInput = z.infer<typeof workflowApproveSchema>;
export type WorkflowRejectInput = z.infer<typeof workflowRejectSchema>;
export type BulkWorkflowRejectInput = z.infer<typeof bulkWorkflowRejectSchema>;
