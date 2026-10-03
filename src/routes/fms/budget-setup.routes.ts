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

// Budget Management (list/create/update/export/documents) is a Super Admin
// + Admin + Maker menu — Verifier/Checker have no Budget Management access
// at all, they only reach Approvals. List/export/get are further node-scoped
// to Maker's own assigned nodes inside the service (a Maker never browses
// another department's data). verify/approve/reject are split by exact
// operational role below — Verifier can verify or reject, Checker can
// approve or reject, neither can do the other's action — with the real
// Organization Node + workflow-status enforcement happening inside the
// service (see financial-workflow.service.ts).
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
// Active/Inactive status is an administrative archival flag, not part of
// the Maker's create/edit workflow — stays Super Admin + Admin only.
const canManageStatus = authorizeRoles("Super Admin", "Admin");

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
  canManageStatus,
  validate(objectIdParamsSchema, "params"),
  validate(updateBudgetSetupStatusSchema, "body"),
  controller.updateBudgetSetupStatus
);
router.post(
  "/:id/verify",
  canVerify,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyBudgetSetup
);
router.post(
  "/:id/approve",
  canApprove,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveBudgetSetup
);
router.post(
  "/:id/reject",
  canReject,
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
