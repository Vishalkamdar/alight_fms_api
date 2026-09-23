import { z } from "zod";

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

export type WorkflowVerifyInput = z.infer<typeof workflowVerifySchema>;
export type WorkflowApproveInput = z.infer<typeof workflowApproveSchema>;
export type WorkflowRejectInput = z.infer<typeof workflowRejectSchema>;
