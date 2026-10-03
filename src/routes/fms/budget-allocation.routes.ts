import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  budgetAllocationExportQuerySchema,
  budgetAllocationListQuerySchema,
  budgetAllocationNodeTotalsQuerySchema,
  bulkWorkflowActionSchema,
  createBudgetAllocationSchema,
  createBulkBudgetAllocationsSchema,
} from "../../schemas/fms/budget-allocation.schema";
import {
  workflowApproveSchema,
  workflowRejectSchema,
  workflowVerifySchema,
} from "../../schemas/fms/financial-workflow.schema";
import * as controller from "../../controllers/fms/budget-allocation.controller";

const router = Router();

router.use(authenticate);

// Matches Budget Setup's access split: list/create/update/export is a Super
// Admin + Admin + Maker (Budget Management) menu, node-scoped to Maker's own
// nodes inside the service; verify/approve/reject are split by exact
// operational role — Verifier can verify or reject, Checker can approve or
// reject, neither can do the other's action — with the real Organization
// Node + workflow-status enforcement happening inside the service (see
// financial-workflow.service.ts).
const canRead = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker");
const canWrite = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker");
const canVerify = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Verifier");
const canApprove = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Checker");
const canReject = authorizeRoles(
  "Super Admin",
  "Admin",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker"
);

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get(
  "/export",
  canRead,
  validate(budgetAllocationExportQuerySchema, "query"),
  controller.exportBudgetAllocations
);
router.get(
  "/node-totals",
  canRead,
  validate(budgetAllocationNodeTotalsQuerySchema, "query"),
  controller.getBudgetAllocationNodeTotals
);
// Must be registered before "/:id" too — a Maker's own list of selectable
// allocation targets (§17: the row list itself must be pre-scoped, not just
// the create action).
router.get("/my-allocatable-nodes", canRead, controller.getMyAllocatableNodes);

// The Budget Verification / Budget Checker screens — each gated to exactly
// the one role that can act at that stage, node-scoped inside the service
// (listPendingApprovalsForStage). Also registered before "/:id".
router.get(
  "/pending/verification",
  canVerify,
  validate(budgetAllocationListQuerySchema, "query"),
  controller.listPendingVerification
);
router.get(
  "/pending/verification/export",
  canVerify,
  validate(budgetAllocationExportQuerySchema, "query"),
  controller.exportPendingVerification
);
router.get(
  "/pending/checker",
  canApprove,
  validate(budgetAllocationListQuerySchema, "query"),
  controller.listPendingChecker
);
router.get(
  "/pending/checker/export",
  canApprove,
  validate(budgetAllocationExportQuerySchema, "query"),
  controller.exportPendingChecker
);
router.post(
  "/bulk-verify",
  canVerify,
  validate(bulkWorkflowActionSchema, "body"),
  controller.bulkVerifyBudgetAllocations
);
router.post(
  "/bulk-approve",
  canApprove,
  validate(bulkWorkflowActionSchema, "body"),
  controller.bulkApproveBudgetAllocations
);
router.post(
  "/bulk",
  canWrite,
  validate(createBulkBudgetAllocationsSchema, "body"),
  controller.createBulkBudgetAllocations
);
// Multipart — multer parses the file itself inside the controller, so no
// JSON body validate() middleware runs here (see uploadBudgetAllocationDocuments).
router.post("/documents", canWrite, controller.uploadBudgetAllocationDocuments);

router.get(
  "/",
  canRead,
  validate(budgetAllocationListQuerySchema, "query"),
  controller.listBudgetAllocations
);
router.post(
  "/",
  canWrite,
  validate(createBudgetAllocationSchema, "body"),
  controller.createBudgetAllocation
);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), controller.getBudgetAllocation);
router.post(
  "/:id/verify",
  canVerify,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyBudgetAllocation
);
router.post(
  "/:id/approve",
  canApprove,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveBudgetAllocation
);
router.post(
  "/:id/reject",
  canReject,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectBudgetAllocation
);

export default router;
