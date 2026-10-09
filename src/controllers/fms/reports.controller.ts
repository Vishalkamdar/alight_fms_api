import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { streamPdfReport, type PdfReportColumn } from "../../utils/fms/pdf-report";
import { formatCurrencyPlain } from "../../utils/fms/format";
import * as reportsService from "../../services/fms/reports.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { ReportExportQuery, ReportFilters, ApprovalStatusFilters, ApprovalStatusExportQuery, FinancialYearSummaryQuery } from "../../schemas/fms/reports.schema";

const EXPORT_LIMIT = 5000;

function csvResponse(res: Response, filenameBase: string, header: string[]): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(header));
}

// ---------------------------------------------------------------------------
// §3 — Budget Summary
// ---------------------------------------------------------------------------

export async function getBudgetSummaryReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetSummaryReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function getBudgetSummaryDrilldown(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetSummaryDrilldown(id, filters, context);
  sendSuccess(res, result);
}

export async function exportBudgetSummaryReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetSummaryReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  const columns: PdfReportColumn[] = [
    { key: "nodeName", label: "Organization Node" },
    { key: "totalBudget", label: "Total Budget", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "allocated", label: "Allocated", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "available", label: "Available", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "onHold", label: "On Hold", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "used", label: "Used", format: (v) => formatCurrencyPlain(Number(v)) },
  ];

  if (query.format === "pdf") {
    streamPdfReport(res, { title: "Budget Summary Report", columns, rows: result.items });
    return;
  }

  csvResponse(res, "budget-summary", ["Organization Node", "Total Budget", "Allocated", "Available", "On Hold", "Used", "Remaining"]);
  for (const row of result.items) {
    res.write(toCsvRow([row.nodeName, row.totalBudget, row.allocated, row.available, row.onHold, row.used, row.remaining]));
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §4 — Budget Allocation
// ---------------------------------------------------------------------------

export async function getBudgetAllocationReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetAllocationReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportBudgetAllocationReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetAllocationReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "budget-allocation", [
    "Allocation Number", "Date", "Financial Year", "Organization Node", "Scheme", "Head", "Amount", "Status", "Maker", "Verifier", "Checker", "Approval Date",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([
        row._id,
        new Date(row.createdAt).toISOString(),
        row.financialYear?.financialYear ?? "",
        row.organizationNode?.name ?? "",
        "",
        row.head?.name ?? "",
        row.amount,
        row.approvalStatus,
        row.maker?.fullname ?? "",
        "",
        "",
        row.approvedAt ? new Date(row.approvedAt).toISOString() : "",
      ])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §5 — Budget Availability
// ---------------------------------------------------------------------------

export async function getBudgetAvailabilityReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetAvailabilityReport(filters, context);
  sendSuccess(res, result);
}

export async function exportBudgetAvailabilityReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBudgetAvailabilityReport(query, context);
  const rows = [result];
  const columns: PdfReportColumn[] = [
    { key: "totalBudget", label: "Total Budget", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "allocated", label: "Allocated", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "available", label: "Available", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "onHold", label: "On Hold", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "used", label: "Used", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "returned", label: "Returned", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "pulled", label: "Pulled", format: (v) => formatCurrencyPlain(Number(v)) },
  ];

  if (query.format === "pdf") {
    streamPdfReport(res, { title: "Budget Availability Report", columns, rows });
    return;
  }

  csvResponse(res, "budget-availability", ["Total Budget", "Allocated", "Available", "On Hold", "Used", "Returned", "Pulled"]);
  res.write(toCsvRow([result.totalBudget, result.allocated, result.available, result.onHold, result.used, result.returned, result.pulled]));
  res.end();
}

// ---------------------------------------------------------------------------
// §6 — Expenditure Report
// ---------------------------------------------------------------------------

export async function getExpenditureReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getExpenditureReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportExpenditureReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getExpenditureReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "expenditure-report", [
    "Bill/Voucher Number", "Date", "Organization Node", "Scheme", "Head", "Beneficiary", "Beneficiary Type",
    "Gross Amount", "Tax", "Deduction", "Net Payable", "Approval Status", "Payment Status", "Maker", "Verifier", "Checker", "Payment Date",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([
        row.billVoucherNumber,
        new Date(row.billVoucherDate).toISOString().slice(0, 10),
        row.organizationNode,
        row.schemeHeadRoot,
        row.head,
        row.beneficiary,
        row.beneficiaryType,
        row.grossAmount,
        row.tax,
        row.deduction,
        row.netPayableAmount,
        row.approvalStatus,
        row.paymentStatus,
        row.maker,
        row.verifier,
        row.checker,
        row.paymentDate ? new Date(row.paymentDate).toISOString() : "",
      ])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §7/§8 — Payroll Report (+ Employee Payroll Detail)
// ---------------------------------------------------------------------------

export async function getPayrollReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getPayrollReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function getEmployeePayrollDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const result = await reportsService.getEmployeePayrollDetail(id, context);
  sendSuccess(res, result);
}

export async function exportPayrollReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getPayrollReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "payroll-report", [
    "Payroll Number", "Month", "Organization Node", "Scheme", "Employee Count", "Gross Salary", "Total Deductions", "Net Payroll",
    "Approval Status", "Payment Status", "Maker", "Verifier", "Checker",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([
        row.payrollNumber, row.month, row.organizationNode, row.schemeHeadRoot, row.employeeCount,
        row.grossSalary, row.totalDeduction, row.netPayroll, row.approvalStatus, row.paymentStatus, row.maker, row.verifier, row.checker,
      ])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §9 — Approval Status Report
// ---------------------------------------------------------------------------

export async function getApprovalStatusReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ApprovalStatusFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getApprovalStatusReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportApprovalStatusReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ApprovalStatusExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getApprovalStatusReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "approval-status", [
    "Module", "Transaction", "Organization Node", "Amount", "Maker", "Verifier", "Checker", "Current Stage", "Status",
    "Created Date", "Verification Date", "Approval Date",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([
        row.module, row.transactionNumber, row.organizationNode, row.amount, row.maker, row.verifier, row.checker, row.currentStage, row.status,
        new Date(row.createdDate).toISOString(), row.verificationDate ? new Date(row.verificationDate).toISOString() : "", row.approvalDate ? new Date(row.approvalDate).toISOString() : "",
      ])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §10 — Payment Status Report
// ---------------------------------------------------------------------------

export async function getPaymentStatusReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getPaymentStatusReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportPaymentStatusReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getPaymentStatusReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "payment-status", [
    "Transaction Number", "Module", "Beneficiary", "Beneficiary Type", "Organization Node", "Amount", "Payment Status", "Payment Reference", "Payment Date", "Failure Reason",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([
        row.transactionNumber, row.module, row.beneficiary, row.beneficiaryType, row.organizationNode, row.amount, row.paymentStatus,
        row.paymentReference ?? "", row.paymentDate ? new Date(row.paymentDate).toISOString() : "", row.failureReason ?? "",
      ])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §11 — Organization Node Financial Report
// ---------------------------------------------------------------------------

export async function getOrganizationNodeFinancialReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getOrganizationNodeFinancialReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportOrganizationNodeFinancialReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getOrganizationNodeFinancialReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  const columns: PdfReportColumn[] = [
    { key: "nodeName", label: "Department" },
    { key: "budget", label: "Budget", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "allocated", label: "Allocated", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "available", label: "Available", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "onHold", label: "On Hold", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "expenditure", label: "Expenditure", format: (v) => formatCurrencyPlain(Number(v)) },
    { key: "payroll", label: "Payroll", format: (v) => formatCurrencyPlain(Number(v)) },
  ];

  if (query.format === "pdf") {
    streamPdfReport(res, { title: "Organization Node Financial Report", columns, rows: result.items });
    return;
  }

  csvResponse(res, "organization-node-financial", ["Department", "Budget", "Allocated", "Available", "On Hold", "Expenditure", "Payroll"]);
  for (const row of result.items) {
    res.write(toCsvRow([row.nodeName, row.budget, row.allocated, row.available, row.onHold, row.expenditure, row.payroll]));
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §12 — Beneficiary Payment Report
// ---------------------------------------------------------------------------

export async function getBeneficiaryPaymentReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = res.locals.query as ReportFilters;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBeneficiaryPaymentReport(filters, context);
  sendSuccess(res, result.items, { meta: result.meta });
}

export async function exportBeneficiaryPaymentReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  assertCsvOnlyModuleFilter(req);
  const query = res.locals.query as ReportExportQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getBeneficiaryPaymentReport({ ...query, page: 1, limit: EXPORT_LIMIT }, context);

  csvResponse(res, "beneficiary-payments", [
    "Beneficiary", "Beneficiary Type", "Organization Node", "Transactions", "Gross Amount", "Deduction", "Net Amount", "Paid Amount", "Pending Amount",
  ]);
  for (const row of result.items) {
    res.write(
      toCsvRow([row.beneficiary, row.beneficiaryType, row.organizationNode, row.transactionCount, row.grossAmount, row.deduction, row.netAmount, row.paidAmount, row.pendingAmount])
    );
  }
  res.end();
}

// ---------------------------------------------------------------------------
// §13/§14 — Financial Year Summary
// ---------------------------------------------------------------------------

export async function getFinancialYearSummaryReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FinancialYearSummaryQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getFinancialYearSummaryReport(query, context);
  sendSuccess(res, result);
}

export async function exportFinancialYearSummaryReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FinancialYearSummaryQuery;
  const context = getActorContextWithRole(req);
  const result = await reportsService.getFinancialYearSummaryReport(query, context);

  if (query.format === "pdf") {
    const kpiTiles = [
      { label: "Total Budget", value: formatCurrencyPlain(result.budgetKpis.totalBudget) },
      { label: "Allocated", value: formatCurrencyPlain(result.budgetKpis.allocated) },
      { label: "Available", value: formatCurrencyPlain(result.budgetKpis.available) },
      { label: "On Hold", value: formatCurrencyPlain(result.budgetKpis.onHold) },
      { label: "Expenditure", value: formatCurrencyPlain(result.budgetKpis.totalExpenditure) },
      { label: "Payroll", value: formatCurrencyPlain(result.budgetKpis.totalPayroll) },
    ];
    const columns: PdfReportColumn[] = [
      { key: "month", label: "Month" },
      { key: "expenditure", label: "Expenditure", format: (v) => formatCurrencyPlain(Number(v)) },
      { key: "payroll", label: "Payroll", format: (v) => formatCurrencyPlain(Number(v)) },
    ];
    streamPdfReport(res, { title: `Financial Year Summary — ${result.financialYear}`, kpiTiles, columns, rows: result.monthlyTrend });
    return;
  }

  csvResponse(res, "financial-year-summary", ["Month", "Expenditure", "Payroll"]);
  for (const row of result.monthlyTrend) {
    res.write(toCsvRow([row.month, row.expenditure, row.payroll]));
  }
  res.end();
}

export function assertCsvOnlyModuleFilter(req: AuthenticatedRequest): void {
  if (req.query.format === "pdf") {
    throw new AppError(400, "PDF export is only available for Budget Summary, Budget Availability, Organization Node Financial, and Financial Year Summary.");
  }
}
