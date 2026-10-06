import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { uploadExpenditureDocument } from "../../utils/fms/upload";
import { getAllowedNodeIdsForList } from "../../services/fms/financial-workflow.service";
import * as expenditureService from "../../services/fms/expenditure.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateExpenditureInput,
  ExpenditureExportQuery,
  ExpenditureListQuery,
} from "../../schemas/fms/expenditure.schema";

export async function listExpenditures(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ExpenditureListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const { items, meta } = await expenditureService.listExpenditures(query, allowedNodeIds);
  sendSuccess(res, items, { meta, message: "Expenditures retrieved successfully." });
}

export async function getExpenditure(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const expenditure = await expenditureService.getExpenditureById(id, allowedNodeIds);
  sendSuccess(res, expenditure);
}

export async function createExpenditure(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateExpenditureInput;
  const context = getActorContextWithRole(req);
  const expenditure = await expenditureService.createExpenditure(body, context);
  sendSuccess(res, expenditure, { statusCode: 201, message: "Expenditure created." });
}

export async function verifyExpenditure(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { remarks?: string };
  const context = getActorContextWithRole(req);
  const expenditure = await expenditureService.verifyExpenditure(id, body, context);
  sendSuccess(res, expenditure, { message: "Expenditure verified." });
}

export async function approveExpenditure(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { remarks?: string };
  const context = getActorContextWithRole(req);
  const expenditure = await expenditureService.approveExpenditure(id, body, context);
  sendSuccess(res, expenditure, { message: "Expenditure approved." });
}

export async function rejectExpenditure(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as { reason: string };
  const context = getActorContextWithRole(req);
  const expenditure = await expenditureService.rejectExpenditure(id, body, context);
  sendSuccess(res, expenditure, { message: "Expenditure rejected." });
}

export async function retryExpenditurePayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const expenditure = await expenditureService.retryExpenditurePayment(id, context);
  sendSuccess(res, expenditure, { message: "Payment retry initiated." });
}

export async function getMyPendingExpenditures(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stage = (req.query.stage === "Checker" ? "Checker" : "Verifier") as "Verifier" | "Checker";
  const query = res.locals.query as ExpenditureListQuery;
  const context = getActorContextWithRole(req);
  const result = await expenditureService.listPendingExpenditureApprovalsForStage(stage, context, query);
  sendSuccess(res, result.items, { meta: result.meta, message: "Pending Expenditures retrieved." });
}

const CSV_HEADER = [
  "Bill/Voucher Number",
  "Date",
  "Beneficiary",
  "Beneficiary Type",
  "Gross Amount",
  "Deduction",
  "Net Payable",
  "Approval Status",
  "Payment Status",
  "Created Date",
];

export async function exportExpenditures(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as ExpenditureExportQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const cursor = expenditureService.getExpenditureCursorForExport(query, allowedNodeIds);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="expenditures-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));

  for await (const doc of cursor) {
    res.write(
      toCsvRow([
        doc.billVoucherNumber,
        new Date(doc.billVoucherDate).toISOString().slice(0, 10),
        doc.beneficiarySnapshot.name,
        doc.beneficiaryType === "VENDOR" ? "Vendor" : "Employee",
        String(doc.grossAmount),
        String(doc.totalDeduction),
        String(doc.netPayableAmount),
        doc.approvalStatus,
        doc.paymentStatus,
        new Date(doc.createdAt).toISOString(),
      ])
    );
  }
  res.end();
}

export async function addExpenditureDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };

  await new Promise<void>((resolve, reject) => {
    uploadExpenditureDocument(req, res, (err: unknown) => {
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
  const expenditure = await expenditureService.addExpenditureDocument(id, documentInfo, req.file, context);
  sendSuccess(res, expenditure, { message: "Document uploaded." });
}
