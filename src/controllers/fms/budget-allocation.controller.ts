import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext, getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { uploadBudgetAllocationDocument } from "../../utils/fms/upload";
import * as budgetAllocationService from "../../services/fms/budget-allocation.service";
import { getAllowedNodeIdsForList } from "../../services/fms/financial-workflow.service";
import { attachBudgetAllocationDocumentSchema } from "../../schemas/fms/budget-allocation.schema";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BudgetAllocationExportQuery,
  BudgetAllocationListQuery,
  BudgetAllocationNodeTotalsQuery,
  BulkWorkflowActionInput,
  CreateBudgetAllocationInput,
  CreateBulkBudgetAllocationsInput,
} from "../../schemas/fms/budget-allocation.schema";
import type {
  WorkflowApproveInput,
  WorkflowRejectInput,
  WorkflowVerifyInput,
} from "../../schemas/fms/financial-workflow.schema";

export async function listBudgetAllocations(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const { items, meta } = await budgetAllocationService.listBudgetAllocations(query, allowedNodeIds);
  sendSuccess(res, items, { meta, message: "Budget Allocations retrieved successfully." });
}

export async function getBudgetAllocation(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const allocation = await budgetAllocationService.getBudgetAllocationById(id, allowedNodeIds);
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

export async function listPendingVerification(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationListQuery;
  const context = getActorContextWithRole(req);
  const { items, meta } = await budgetAllocationService.listPendingApprovalsForStage("Verifier", context, query);
  sendSuccess(res, items, { meta, message: "Pending verifications retrieved successfully." });
}

export async function listPendingChecker(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationListQuery;
  const context = getActorContextWithRole(req);
  const { items, meta } = await budgetAllocationService.listPendingApprovalsForStage("Checker", context, query);
  sendSuccess(res, items, { meta, message: "Pending Checker approvals retrieved successfully." });
}

export async function bulkVerifyBudgetAllocations(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { ids, remarks } = res.locals.body as BulkWorkflowActionInput;
  const context = getActorContextWithRole(req);
  const result = await budgetAllocationService.bulkVerifyBudgetAllocations(ids, { remarks }, context);
  sendSuccess(res, result, {
    message: `${result.succeeded.length} verified, ${result.failed.length} failed.`,
  });
}

export async function bulkApproveBudgetAllocations(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { ids, remarks } = res.locals.body as BulkWorkflowActionInput;
  const context = getActorContextWithRole(req);
  const result = await budgetAllocationService.bulkApproveBudgetAllocations(ids, { remarks }, context);
  sendSuccess(res, result, {
    message: `${result.succeeded.length} approved, ${result.failed.length} failed.`,
  });
}

const APPROVAL_CSV_HEADER = [
  "Allocation Number",
  "Date",
  "Financial Year",
  "Organization Node",
  "Scheme / Head",
  "Budget Setup Reference",
  "Description / Purpose",
  "Amount",
  "Maker",
  "Current Status",
  "Submitted Date",
];

function writeApprovalCsvRows(res: Response, cursor: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const row of cursor) {
      const dto = budgetAllocationService.serializeBudgetAllocationRowForExport(
        row as Parameters<typeof budgetAllocationService.serializeBudgetAllocationRowForExport>[0]
      );
      res.write(
        toCsvRow([
          dto._id,
          new Date(dto.createdAt).toISOString(),
          dto.financialYear?.financialYear ?? "",
          dto.organizationNode?.name ?? "",
          dto.head?.name ?? "",
          dto.sourcePools.map((pool) => pool.budgetSetupId).join("; "),
          dto.remarks ?? "",
          dto.amount,
          dto.maker?.fullname ?? "",
          dto.approvalStatus,
          new Date(dto.createdAt).toISOString(),
        ])
      );
    }
  })();
}

export async function exportPendingVerification(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationExportQuery;
  const context = getActorContextWithRole(req);
  const cursor = await budgetAllocationService.getPendingApprovalsCursorForStage("Verifier", context, query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pending-verification-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.write(toCsvRow(APPROVAL_CSV_HEADER));
  if (cursor) await writeApprovalCsvRows(res, cursor);
  res.end();
}

export async function exportPendingChecker(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationExportQuery;
  const context = getActorContextWithRole(req);
  const cursor = await budgetAllocationService.getPendingApprovalsCursorForStage("Checker", context, query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pending-checker-approval-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.write(toCsvRow(APPROVAL_CSV_HEADER));
  if (cursor) await writeApprovalCsvRows(res, cursor);
  res.end();
}

export async function getBudgetAllocationNodeTotals(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const scope = res.locals.query as BudgetAllocationNodeTotalsQuery;
  const totals = await budgetAllocationService.getBudgetAllocationNodeTotals(scope);
  sendSuccess(res, totals);
}

export async function getMyAllocatableNodes(req: AuthenticatedRequest, res: Response): Promise<void> {
  const context = getActorContextWithRole(req);
  const nodes = await budgetAllocationService.getMyAllocatableNodes(context);
  sendSuccess(res, nodes);
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

export async function exportBudgetAllocations(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BudgetAllocationExportQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const cursor = budgetAllocationService.getBudgetAllocationsCursorForExport(query, allowedNodeIds);

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
