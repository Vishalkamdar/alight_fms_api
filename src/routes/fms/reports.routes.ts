import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  reportFiltersSchema,
  reportExportQuerySchema,
  approvalStatusFiltersSchema,
  approvalStatusExportQuerySchema,
  financialYearSummaryQuerySchema,
} from "../../schemas/fms/reports.schema";
import * as controller from "../../controllers/fms/reports.controller";

const router = Router();

router.use(authenticate);

// One Reports module for every role — the route never branches by role,
// only the data (scoped via getAllowedNodeIdsForList/getMyActionableNodeIds
// inside each service function) ever does.
const canView = authorizeRoles(
  "Super Admin",
  "Admin",
  "FMS Operational User - Maker",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker"
);

router.get("/budget-summary", canView, validate(reportFiltersSchema, "query"), controller.getBudgetSummaryReport);
router.get("/budget-summary/export", canView, validate(reportExportQuerySchema, "query"), controller.exportBudgetSummaryReport);
router.get(
  "/budget-summary/:id/drilldown",
  canView,
  validate(objectIdParamsSchema, "params"),
  validate(reportFiltersSchema, "query"),
  controller.getBudgetSummaryDrilldown
);

router.get("/budget-allocation", canView, validate(reportFiltersSchema, "query"), controller.getBudgetAllocationReport);
router.get("/budget-allocation/export", canView, validate(reportExportQuerySchema, "query"), controller.exportBudgetAllocationReport);

router.get("/budget-availability", canView, validate(reportFiltersSchema, "query"), controller.getBudgetAvailabilityReport);
router.get("/budget-availability/export", canView, validate(reportExportQuerySchema, "query"), controller.exportBudgetAvailabilityReport);

router.get("/expenditure", canView, validate(reportFiltersSchema, "query"), controller.getExpenditureReport);
router.get("/expenditure/export", canView, validate(reportExportQuerySchema, "query"), controller.exportExpenditureReport);

router.get("/payroll", canView, validate(reportFiltersSchema, "query"), controller.getPayrollReport);
router.get("/payroll/export", canView, validate(reportExportQuerySchema, "query"), controller.exportPayrollReport);
router.get("/payroll/:id/employees", canView, validate(objectIdParamsSchema, "params"), controller.getEmployeePayrollDetail);

router.get("/approval-status", canView, validate(approvalStatusFiltersSchema, "query"), controller.getApprovalStatusReport);
router.get("/approval-status/export", canView, validate(approvalStatusExportQuerySchema, "query"), controller.exportApprovalStatusReport);

router.get("/payment-status", canView, validate(reportFiltersSchema, "query"), controller.getPaymentStatusReport);
router.get("/payment-status/export", canView, validate(reportExportQuerySchema, "query"), controller.exportPaymentStatusReport);

router.get("/organization-node-financial", canView, validate(reportFiltersSchema, "query"), controller.getOrganizationNodeFinancialReport);
router.get(
  "/organization-node-financial/export",
  canView,
  validate(reportExportQuerySchema, "query"),
  controller.exportOrganizationNodeFinancialReport
);

router.get("/beneficiary-payments", canView, validate(reportFiltersSchema, "query"), controller.getBeneficiaryPaymentReport);
router.get("/beneficiary-payments/export", canView, validate(reportExportQuerySchema, "query"), controller.exportBeneficiaryPaymentReport);

router.get("/financial-year-summary", canView, validate(financialYearSummaryQuerySchema, "query"), controller.getFinancialYearSummaryReport);
router.get(
  "/financial-year-summary/export",
  canView,
  validate(financialYearSummaryQuerySchema, "query"),
  controller.exportFinancialYearSummaryReport
);

export default router;
