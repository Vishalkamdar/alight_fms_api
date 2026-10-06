import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createExpenditureSchema,
  expenditureExportQuerySchema,
  expenditureListQuerySchema,
} from "../../schemas/fms/expenditure.schema";
import { workflowApproveSchema, workflowRejectSchema, workflowVerifySchema } from "../../schemas/fms/financial-workflow.schema";
import * as controller from "../../controllers/fms/expenditure.controller";

const router = Router();

router.use(authenticate);

// §22 — Maker creates/edits/submits; Verifier/Checker only ever view +
// act on their own stage, never create or modify amounts; Super Admin/Admin
// can do everything (same role split as Budget Allocation's routes).
const canWrite = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker");
const canVerify = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Verifier");
const canApprove = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Checker");
const canReject = authorizeRoles(
  "Super Admin",
  "Admin",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker"
);
const canRetryPayment = authorizeRoles("Super Admin", "Admin");

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get("/export", canWrite, validate(expenditureExportQuerySchema, "query"), controller.exportExpenditures);
router.get(
  "/pending",
  authorizeRoles("Super Admin", "Admin", "FMS Operational User - Verifier", "FMS Operational User - Checker"),
  validate(expenditureListQuerySchema, "query"),
  controller.getMyPendingExpenditures
);

router.get("/", canWrite, validate(expenditureListQuerySchema, "query"), controller.listExpenditures);
router.post("/", canWrite, validate(createExpenditureSchema, "body"), controller.createExpenditure);
router.get("/:id", canWrite, validate(objectIdParamsSchema, "params"), controller.getExpenditure);
router.post(
  "/:id/documents",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  controller.addExpenditureDocument
);
router.post(
  "/:id/verify",
  canVerify,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyExpenditure
);
router.post(
  "/:id/approve",
  canApprove,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveExpenditure
);
router.post(
  "/:id/reject",
  canReject,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectExpenditure
);
router.post(
  "/:id/retry-payment",
  canRetryPayment,
  validate(objectIdParamsSchema, "params"),
  controller.retryExpenditurePayment
);

export default router;
