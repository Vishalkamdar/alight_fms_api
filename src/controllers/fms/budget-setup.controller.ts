import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext, getActorContextWithRole } from "../../utils/requestContext";
import { uploadBudgetDocument } from "../../utils/fms/upload";
import { toCsvRow } from "../../utils/csv";
import * as budgetSetupService from "../../services/fms/budget-setup.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BudgetSetupExportQuery,
  BudgetSetupListQuery,
  CreateBudgetSetupInput,
  UpdateBudgetSetupInput,
  UpdateBudgetSetupStatusInput,
} from "../../schemas/fms/budget-setup.schema";
import type {
  WorkflowApproveInput,
  WorkflowRejectInput,
  WorkflowVerifyInput,
} from "../../schemas/fms/financial-workflow.schema";

export async function listBudgetSetups(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetSetupListQuery;
  const { items, meta } = await budgetSetupService.listBudgetSetups(query);
  sendSuccess(res, items, { meta, message: "Budget Setups retrieved successfully." });
}

const CSV_HEADER = [
  "Financial Year",
  "Organization Node",
  "Scheme / Head Node",
  "Original Amount",
  "Allocated Amount",
  "Remaining Amount",
  "Status",
  "Approval Status",
  "Remarks",
  "Created At",
];

/**
 * Streams the CSV row-by-row from a Mongo cursor instead of building the
 * full export in memory first — required so a large Budget Setup collection
 * can't spike server memory just because someone clicked "Export CSV".
 */
export async function exportBudgetSetups(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetSetupExportQuery;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="budget-setups-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  res.write(toCsvRow(CSV_HEADER));

  const cursor = budgetSetupService.getBudgetSetupsCursorForExport(query);
  for await (const row of cursor) {
    const dto = budgetSetupService.serializeBudgetSetupRowForExport(row);
    res.write(
      toCsvRow([
        dto.financialYear?.financialYear ?? "",
        dto.organizationNode?.name ?? "",
        dto.schemeHeadNode?.name ?? "",
        dto.originalAmount,
        dto.allocatedAmount,
        dto.remainingAmount,
        dto.status,
        dto.approvalStatus,
        dto.remarks ?? "",
        new Date(dto.createdAt).toISOString(),
      ])
    );
  }

  res.end();
}

export async function getBudgetSetup(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const budgetSetup = await budgetSetupService.getBudgetSetupById(id);
  sendSuccess(res, budgetSetup);
}

export async function getAvailableBudget(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const available = await budgetSetupService.getAvailableBudget(id);
  sendSuccess(res, available);
}

export async function createBudgetSetup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateBudgetSetupInput;
  const context = getActorContextWithRole(req);
  const budgetSetup = await budgetSetupService.createBudgetSetup(body, context);
  sendSuccess(res, budgetSetup, { statusCode: 201, message: "Budget Setup created." });
}

export async function verifyBudgetSetup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowVerifyInput;
  const context = getActorContextWithRole(req);
  const budgetSetup = await budgetSetupService.verifyBudgetSetup(id, body, context);
  sendSuccess(res, budgetSetup, { message: "Budget Setup verified." });
}

export async function approveBudgetSetup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowApproveInput;
  const context = getActorContextWithRole(req);
  const budgetSetup = await budgetSetupService.approveBudgetSetup(id, body, context);
  sendSuccess(res, budgetSetup, { message: "Budget Setup approved." });
}

export async function rejectBudgetSetup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowRejectInput;
  const context = getActorContextWithRole(req);
  const budgetSetup = await budgetSetupService.rejectBudgetSetup(id, body, context);
  sendSuccess(res, budgetSetup, { message: "Budget Setup rejected." });
}

export async function updateBudgetSetup(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateBudgetSetupInput;
  const context = getActorContext(req);
  const budgetSetup = await budgetSetupService.updateBudgetSetup(id, body, context);
  sendSuccess(res, budgetSetup, { message: "Budget Setup updated." });
}

export async function updateBudgetSetupStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as UpdateBudgetSetupStatusInput;
  const context = getActorContext(req);
  const budgetSetup = await budgetSetupService.updateBudgetSetupStatus(id, status, context);
  sendSuccess(res, budgetSetup, { message: "Budget Setup status updated." });
}

export async function uploadBudgetSetupDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    uploadBudgetDocument(req, res, (err: unknown) => {
      if (err) {
        reject(new AppError(400, err instanceof Error ? err.message : "Failed to upload document."));
        return;
      }
      resolve();
    });
  });

  if (!req.file) {
    throw new AppError(400, "A document file is required.");
  }

  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  const budgetSetup = await budgetSetupService.addBudgetSetupDocument(id, req.file, context);
  sendSuccess(res, budgetSetup, { statusCode: 201, message: "Document uploaded." });
}

export async function deleteBudgetSetupDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id, documentId } = res.locals.params as { id: string; documentId: string };
  const context = getActorContext(req);
  const budgetSetup = await budgetSetupService.removeBudgetSetupDocument(id, documentId, context);
  sendSuccess(res, budgetSetup, { message: "Document removed." });
}
