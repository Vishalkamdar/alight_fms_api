import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { uploadPayrollDocument } from "../../utils/fms/upload";
import { getAllowedNodeIdsForList } from "../../services/fms/financial-workflow.service";
import * as payrollService from "../../services/fms/payroll.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BulkWorkflowIdsInput,
  CreatePayrollBatchInput,
  PayrollExportQuery,
  PayrollListQuery,
} from "../../schemas/fms/payroll.schema";

export async function listPayrollBatches(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as PayrollListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const { items, meta } = await payrollService.listPayrollBatches(query, allowedNodeIds);
  sendSuccess(res, items, { meta, message: "Payroll batches retrieved successfully." });
}

export async function getPayrollBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const batch = await payrollService.getPayrollBatchById(id, allowedNodeIds);
  sendSuccess(res, batch);
}

export async function createPayrollBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreatePayrollBatchInput;
  const context = getActorContextWithRole(req);
  const batch = await payrollService.createPayrollBatch(body, context);
  sendSuccess(res, batch, { statusCode: 201, message: "Payroll batch created." });
}

export async function verifyPayrollBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { remarks?: string };
  const context = getActorContextWithRole(req);
  const batch = await payrollService.verifyPayrollBatch(id, body, context);
  sendSuccess(res, batch, { message: "Payroll batch verified." });
}

export async function approvePayrollBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { remarks?: string };
  const context = getActorContextWithRole(req);
  const batch = await payrollService.approvePayrollBatch(id, body, context);
  sendSuccess(res, batch, { message: "Payroll batch approved." });
}

export async function rejectPayrollBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { reason: string };
  const context = getActorContextWithRole(req);
  const batch = await payrollService.rejectPayrollBatch(id, body, context);
  sendSuccess(res, batch, { message: "Payroll batch rejected." });
}

export async function retryPayrollPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const employeeLineId = typeof req.query.employeeLineId === "string" ? req.query.employeeLineId : undefined;
  const context = getActorContextWithRole(req);
  const batch = await payrollService.retryPayrollPayment(id, employeeLineId, context);
  sendSuccess(res, batch, { message: "Payment retry initiated." });
}

export async function bulkVerifyPayrollBatches(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as BulkWorkflowIdsInput;
  const context = getActorContextWithRole(req);
  const result = await payrollService.bulkVerifyPayrollBatches(body.ids, { remarks: body.remarks }, context);
  sendSuccess(res, result, { message: `${result.succeeded.length} verified, ${result.failed.length} failed.` });
}

export async function bulkApprovePayrollBatches(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as BulkWorkflowIdsInput;
  const context = getActorContextWithRole(req);
  const result = await payrollService.bulkApprovePayrollBatches(body.ids, { remarks: body.remarks }, context);
  sendSuccess(res, result, { message: `${result.succeeded.length} approved, ${result.failed.length} failed.` });
}

export async function getMyPendingPayrollBatches(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stage = (req.query.stage === "Checker" ? "Checker" : "Verifier") as "Verifier" | "Checker";
  const query = res.locals.query as PayrollListQuery;
  const context = getActorContextWithRole(req);
  const result = await payrollService.listPendingPayrollApprovalsForStage(stage, context, query);
  sendSuccess(res, result.items, { meta: result.meta, message: "Pending Payroll batches retrieved." });
}

const CSV_HEADER = [
  "Payroll Number",
  "Financial Year",
  "Month",
  "Employee Count",
  "Gross Salary",
  "Total Deduction",
  "Net Salary",
  "Approval Status",
  "Payment Status",
  "Created Date",
];

export async function exportPayrollBatches(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as PayrollExportQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const cursor = payrollService.getPayrollBatchCursorForExport(query, allowedNodeIds);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));

  for await (const doc of cursor) {
    res.write(
      toCsvRow([
        doc.payrollNumber,
        String(doc.financialYearId),
        doc.month,
        String(doc.employees.length),
        String(doc.totalGrossSalary),
        String(doc.totalDeduction),
        String(doc.totalNetSalary),
        doc.approvalStatus,
        doc.paymentStatus,
        new Date(doc.createdAt).toISOString(),
      ])
    );
  }
  res.end();
}

export async function addPayrollBatchDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };

  await new Promise<void>((resolve, reject) => {
    uploadPayrollDocument(req, res, (err: unknown) => {
      if (err) {
        reject(new AppError(400, err instanceof Error ? err.message : "Failed to upload the document."));
        return;
      }
      resolve();
    });
  });

  if (!req.file) throw new AppError(400, "A document file is required.");

  const context = getActorContextWithRole(req);
  const documentInfo = typeof req.body.documentInfo === "string" ? req.body.documentInfo : undefined;
  const batch = await payrollService.addPayrollBatchDocument(id, documentInfo, req.file, context);
  sendSuccess(res, batch, { message: "Document uploaded." });
}
