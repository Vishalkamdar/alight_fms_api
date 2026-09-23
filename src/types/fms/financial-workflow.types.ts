/**
 * Shared across every financial module (Budget Setup, Budget Allocation,
 * and future Fund Allocation / Vendor Invoices / Payments) — kept in its
 * own types-only module (not the workflow service itself) so models can
 * import the type without depending on service logic.
 */

export const APPROVAL_STATUSES = [
  "PENDING_VERIFICATION",
  "PENDING_CHECKER_APPROVAL",
  "APPROVED",
  "REJECTED_BY_VERIFIER",
  "REJECTED_BY_CHECKER",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface WorkflowSnapshot {
  makerRequired: true;
  verifierRequired: boolean;
  checkerRequired: boolean;
}
