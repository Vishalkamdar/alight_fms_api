import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  bulkWorkflowIdsSchema,
  createPayrollBatchSchema,
  payrollExportQuerySchema,
  payrollListQuerySchema,
} from "../../schemas/fms/payroll.schema";
import { workflowApproveSchema, workflowRejectSchema, workflowVerifySchema } from "../../schemas/fms/financial-workflow.schema";
import * as controller from "../../controllers/fms/payroll.controller";

const router = Router();

router.use(authenticate);

// Same role split as Expenditure (§9/§22) — Maker creates/edits/submits;
// Verifier/Checker only ever view + act on their own stage; Super
// Admin/Admin can do everything.
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
router.get("/export", canWrite, validate(payrollExportQuerySchema, "query"), controller.exportPayrollBatches);
router.get(
  "/pending",
  authorizeRoles("Super Admin", "Admin", "FMS Operational User - Verifier", "FMS Operational User - Checker"),
  validate(payrollListQuerySchema, "query"),
  controller.getMyPendingPayrollBatches
);
router.post("/bulk-verify", canVerify, validate(bulkWorkflowIdsSchema, "body"), controller.bulkVerifyPayrollBatches);
router.post("/bulk-approve", canApprove, validate(bulkWorkflowIdsSchema, "body"), controller.bulkApprovePayrollBatches);

router.get("/", canWrite, validate(payrollListQuerySchema, "query"), controller.listPayrollBatches);
router.post("/", canWrite, validate(createPayrollBatchSchema, "body"), controller.createPayrollBatch);
router.get("/:id", canWrite, validate(objectIdParamsSchema, "params"), controller.getPayrollBatch);
router.post("/:id/documents", canWrite, validate(objectIdParamsSchema, "params"), controller.addPayrollBatchDocument);
router.post(
  "/:id/verify",
  canVerify,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyPayrollBatch
);
router.post(
  "/:id/approve",
  canApprove,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approvePayrollBatch
);
router.post(
  "/:id/reject",
  canReject,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectPayrollBatch
);
router.post("/:id/retry-payment", canRetryPayment, validate(objectIdParamsSchema, "params"), controller.retryPayrollPayment);

export default router;
