import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  budgetAllocationExportQuerySchema,
  budgetAllocationListQuerySchema,
  budgetAllocationNodeTotalsQuerySchema,
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
// Admin + Admin (Budget Management) menu; verify/approve/reject belongs to
// Approvals, which FMS Operational User can also reach, with the real
// Maker/Verifier/Checker + Organization Node + workflow-status enforcement
// happening inside the service (see financial-workflow.service.ts).
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin", "Admin");
const canActOnWorkflow = authorizeRoles("Super Admin", "Admin", "FMS Operational User");

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
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyBudgetAllocation
);
router.post(
  "/:id/approve",
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveBudgetAllocation
);
router.post(
  "/:id/reject",
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectBudgetAllocation
);

export default router;
