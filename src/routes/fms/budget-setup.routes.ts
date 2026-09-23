import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  budgetSetupDocumentParamsSchema,
  budgetSetupExportQuerySchema,
  budgetSetupListQuerySchema,
  createBudgetSetupSchema,
  updateBudgetSetupSchema,
  updateBudgetSetupStatusSchema,
} from "../../schemas/fms/budget-setup.schema";
import {
  workflowApproveSchema,
  workflowRejectSchema,
  workflowVerifySchema,
} from "../../schemas/fms/financial-workflow.schema";
import * as controller from "../../controllers/fms/budget-setup.controller";

const router = Router();

router.use(authenticate);

// Budget Management (list/create/update/export/documents) is a Super
// Admin + Admin menu — FMS Operational User has no Budget Management access
// at all. verify/approve/reject below are gated separately: they belong to
// the Approvals module, which Operational User CAN reach, with the real
// Maker/Verifier/Checker + Organization Node + workflow-status enforcement
// happening inside the service (see financial-workflow.service.ts).
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin", "Admin");
const canActOnWorkflow = authorizeRoles("Super Admin", "Admin", "FMS Operational User");

// Must be registered before "/:id" so "export" isn't captured as an id.
router.get(
  "/export",
  canRead,
  validate(budgetSetupExportQuerySchema, "query"),
  controller.exportBudgetSetups
);

router.get("/", canRead, validate(budgetSetupListQuerySchema, "query"), controller.listBudgetSetups);
router.post("/", canWrite, validate(createBudgetSetupSchema, "body"), controller.createBudgetSetup);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), controller.getBudgetSetup);
router.get(
  "/:id/available",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getAvailableBudget
);
router.put(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateBudgetSetupSchema, "body"),
  controller.updateBudgetSetup
);
router.patch(
  "/:id/status",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateBudgetSetupStatusSchema, "body"),
  controller.updateBudgetSetupStatus
);
router.post(
  "/:id/verify",
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyBudgetSetup
);
router.post(
  "/:id/approve",
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveBudgetSetup
);
router.post(
  "/:id/reject",
  canActOnWorkflow,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectBudgetSetup
);
router.post(
  "/:id/documents",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  controller.uploadBudgetSetupDocument
);
router.delete(
  "/:id/documents/:documentId",
  canWrite,
  validate(budgetSetupDocumentParamsSchema, "params"),
  controller.deleteBudgetSetupDocument
);

export default router;
