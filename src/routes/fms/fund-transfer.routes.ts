import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  bulkFundTransferActionSchema,
  createFundTransferSchema,
  fundTransferExportQuerySchema,
  fundTransferListQuerySchema,
  returnableAmountQuerySchema,
} from "../../schemas/fms/fund-transfer.schema";
import {
  workflowApproveSchema,
  workflowRejectSchema,
  workflowVerifySchema,
} from "../../schemas/fms/financial-workflow.schema";
import * as controller from "../../controllers/fms/fund-transfer.controller";

const router = Router();

router.use(authenticate);

// Two completely separate modules/pages sharing one collection+workflow
// engine (see FundTransfer.ts) — Pull is a parent-initiated action (Maker
// permission checked against the destination/parent node inside the
// service), Return is a child-initiated action (checked against the
// source/child node). Both are Maker-tier actions, same as Budget
// Management; Verifier/Checker act on either depending on which node they
// hold that role on, resolved per-record inside the service.
const canWrite = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker");
const canVerify = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Verifier");
const canApprove = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Checker");
const canReject = authorizeRoles(
  "Super Admin",
  "Admin",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker"
);

router.get(
  "/returnable-amount",
  canWrite,
  validate(returnableAmountQuerySchema, "query"),
  controller.getReturnableAmount
);

router.get(
  "/pull/pending/verification",
  canVerify,
  validate(fundTransferListQuerySchema, "query"),
  controller.listPendingVerification
);
router.get(
  "/pull/pending/verification/export",
  canVerify,
  validate(fundTransferExportQuerySchema, "query"),
  controller.exportPendingVerification
);
router.get(
  "/pull/pending/checker",
  canApprove,
  validate(fundTransferListQuerySchema, "query"),
  controller.listPendingChecker
);
router.get(
  "/pull/pending/checker/export",
  canApprove,
  validate(fundTransferExportQuerySchema, "query"),
  controller.exportPendingChecker
);
router.post("/pull/bulk-verify", canVerify, validate(bulkFundTransferActionSchema, "body"), controller.bulkVerifyFundTransfers);
router.post("/pull/bulk-approve", canApprove, validate(bulkFundTransferActionSchema, "body"), controller.bulkApproveFundTransfers);
router.get("/pull/export", canWrite, validate(fundTransferExportQuerySchema, "query"), controller.exportPullTransfers);
router.get("/pull", canWrite, validate(fundTransferListQuerySchema, "query"), controller.listPullTransfers);
router.post("/pull", canWrite, validate(createFundTransferSchema, "body"), controller.createPullTransfer);

router.post("/return/bulk-verify", canVerify, validate(bulkFundTransferActionSchema, "body"), controller.bulkVerifyFundTransfers);
router.post("/return/bulk-approve", canApprove, validate(bulkFundTransferActionSchema, "body"), controller.bulkApproveFundTransfers);
router.get("/return/export", canWrite, validate(fundTransferExportQuerySchema, "query"), controller.exportReturnTransfers);
router.get("/return", canWrite, validate(fundTransferListQuerySchema, "query"), controller.listReturnTransfers);
router.post("/return", canWrite, validate(createFundTransferSchema, "body"), controller.createReturnTransfer);

router.get("/:id", canWrite, validate(objectIdParamsSchema, "params"), controller.getFundTransfer);
router.post(
  "/:id/verify",
  canVerify,
  validate(objectIdParamsSchema, "params"),
  validate(workflowVerifySchema, "body"),
  controller.verifyFundTransfer
);
router.post(
  "/:id/approve",
  canApprove,
  validate(objectIdParamsSchema, "params"),
  validate(workflowApproveSchema, "body"),
  controller.approveFundTransfer
);
router.post(
  "/:id/reject",
  canReject,
  validate(objectIdParamsSchema, "params"),
  validate(workflowRejectSchema, "body"),
  controller.rejectFundTransfer
);

export default router;
