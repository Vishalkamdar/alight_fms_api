import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext, getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { uploadBudgetAllocationDocument } from "../../utils/fms/upload";
import * as budgetAllocationService from "../../services/fms/budget-allocation.service";
import { attachBudgetAllocationDocumentSchema } from "../../schemas/fms/budget-allocation.schema";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BudgetAllocationExportQuery,
  BudgetAllocationListQuery,
  BudgetAllocationNodeTotalsQuery,
  CreateBudgetAllocationInput,
  CreateBulkBudgetAllocationsInput,
} from "../../schemas/fms/budget-allocation.schema";
import type {
  WorkflowApproveInput,
  WorkflowRejectInput,
  WorkflowVerifyInput,
} from "../../schemas/fms/financial-workflow.schema";

export async function listBudgetAllocations(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationListQuery;
  const { items, meta } = await budgetAllocationService.listBudgetAllocations(query);
  sendSuccess(res, items, { meta, message: "Budget Allocations retrieved successfully." });
}

export async function getBudgetAllocation(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const allocation = await budgetAllocationService.getBudgetAllocationById(id);
  sendSuccess(res, allocation);
}

export async function createBudgetAllocation(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateBudgetAllocationInput;
  const context = getActorContextWithRole(req);
  const allocation = await budgetAllocationService.createBudgetAllocation(body, context);
  sendSuccess(res, allocation, { statusCode: 201, message: "Budget Allocation created." });
}

export async function createBulkBudgetAllocations(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateBulkBudgetAllocationsInput;
  const context = getActorContextWithRole(req);
  const allocations = await budgetAllocationService.createBulkBudgetAllocations(body, context);
  sendSuccess(res, allocations, {
    statusCode: 201,
    message: `${allocations.length} Budget Allocation(s) created.`,
  });
}

export async function verifyBudgetAllocation(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowVerifyInput;
  const context = getActorContextWithRole(req);
  const allocation = await budgetAllocationService.verifyBudgetAllocation(id, body, context);
  sendSuccess(res, allocation, { message: "Budget Allocation verified." });
}

export async function approveBudgetAllocation(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowApproveInput;
  const context = getActorContextWithRole(req);
  const allocation = await budgetAllocationService.approveBudgetAllocation(id, body, context);
  sendSuccess(res, allocation, { message: "Budget Allocation approved." });
}

export async function rejectBudgetAllocation(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowRejectInput;
  const context = getActorContextWithRole(req);
  const allocation = await budgetAllocationService.rejectBudgetAllocation(id, body, context);
  sendSuccess(res, allocation, { message: "Budget Allocation rejected." });
}

export async function getBudgetAllocationNodeTotals(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const scope = res.locals.query as BudgetAllocationNodeTotalsQuery;
  const totals = await budgetAllocationService.getBudgetAllocationNodeTotals(scope);
  sendSuccess(res, totals);
}

export async function uploadBudgetAllocationDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    uploadBudgetAllocationDocument(req, res, (err: unknown) => {
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

  // `allocationIds` travels as a JSON-encoded string field alongside the
  // file — multipart form fields can't carry nested arrays natively.
  let allocationIds: unknown;
  try {
    allocationIds = JSON.parse(req.body.allocationIds ?? "[]");
  } catch {
    throw new AppError(400, "allocationIds must be a JSON-encoded array of ids.");
  }
  const parsed = attachBudgetAllocationDocumentSchema.safeParse({ allocationIds });
  if (!parsed.success) {
    throw new AppError(422, "Invalid allocationIds.", { allocationIds: [parsed.error.issues[0]?.message ?? "Invalid."] });
  }

  const context = getActorContext(req);
  const allocations = await budgetAllocationService.addBudgetAllocationDocuments(
    parsed.data.allocationIds,
    req.file,
    context
  );
  sendSuccess(res, allocations, { statusCode: 201, message: "Document uploaded." });
}

const CSV_HEADER = [
  "Financial Year",
  "Organization Node",
  "Head",
  "Require Head",
  "Amount",
  "Approval Status",
  "Remarks",
  "Created At",
];

export async function exportBudgetAllocations(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationExportQuery;
  const cursor = budgetAllocationService.getBudgetAllocationsCursorForExport(query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="budget-allocations-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.write(toCsvRow(CSV_HEADER));

  for await (const row of cursor) {
    const dto = budgetAllocationService.serializeBudgetAllocationRowForExport(row);
    res.write(
      toCsvRow([
        dto.financialYear?.financialYear ?? "",
        dto.organizationNode?.name ?? "",
        dto.head?.name ?? "",
        dto.requireHeadAtCreation ? "Yes" : "No",
        dto.amount,
        dto.approvalStatus,
        dto.remarks ?? "",
        new Date(dto.createdAt).toISOString(),
      ])
    );
  }

  res.end();
}
