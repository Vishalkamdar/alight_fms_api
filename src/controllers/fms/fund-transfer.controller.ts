import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { toCsvRow } from "../../utils/csv";
import * as fundTransferService from "../../services/fms/fund-transfer.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BulkFundTransferActionInput,
  CreateFundTransferInput,
  FundTransferExportQuery,
  FundTransferListQuery,
} from "../../schemas/fms/fund-transfer.schema";
import type {
  WorkflowApproveInput,
  WorkflowRejectInput,
  WorkflowVerifyInput,
} from "../../schemas/fms/financial-workflow.schema";

export async function createPullTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateFundTransferInput;
  const context = getActorContextWithRole(req);
  const transfer = await fundTransferService.createPullTransfer(body, context);
  sendSuccess(res, transfer, { statusCode: 201, message: "Pull request created." });
}

export async function createReturnTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateFundTransferInput;
  const context = getActorContextWithRole(req);
  const transfer = await fundTransferService.createReturnTransfer(body, context);
  sendSuccess(res, transfer, { statusCode: 201, message: "Return request created." });
}

export async function listPullTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await fundTransferService.getAllowedNodeIdsForTransferModule(context);
  const { items, meta } = await fundTransferService.listFundTransfers(
    { ...query, transactionType: "PULL_FROM_CHILD" },
    allowedNodeIds
  );
  sendSuccess(res, items, { meta, message: "Pull transactions retrieved successfully." });
}

export async function listReturnTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await fundTransferService.getAllowedNodeIdsForTransferModule(context);
  const { items, meta } = await fundTransferService.listFundTransfers(
    { ...query, transactionType: "RETURN_TO_PARENT" },
    allowedNodeIds
  );
  sendSuccess(res, items, { meta, message: "Return transactions retrieved successfully." });
}

export async function getFundTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await fundTransferService.getAllowedNodeIdsForTransferModule(context);
  const transfer = await fundTransferService.getFundTransferById(id, allowedNodeIds);
  sendSuccess(res, transfer);
}

export async function getReturnableAmount(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as { nodeId: string; financialYearId: string; organizationRootNodeId: string; schemeHeadRootNodeId: string };
  const breakdown = await fundTransferService.getReturnableAmount(query.nodeId, query);
  sendSuccess(res, { organizationNodeId: query.nodeId, ...breakdown });
}

export async function verifyFundTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowVerifyInput;
  const context = getActorContextWithRole(req);
  const transfer = await fundTransferService.verifyFundTransfer(id, body, context);
  sendSuccess(res, transfer, { message: "Fund Transfer verified." });
}

export async function approveFundTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowApproveInput;
  const context = getActorContextWithRole(req);
  const transfer = await fundTransferService.approveFundTransfer(id, body, context);
  sendSuccess(res, transfer, { message: "Fund Transfer approved." });
}

export async function rejectFundTransfer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as WorkflowRejectInput;
  const context = getActorContextWithRole(req);
  const transfer = await fundTransferService.rejectFundTransfer(id, body, context);
  sendSuccess(res, transfer, { message: "Fund Transfer rejected." });
}

export async function listPendingVerification(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferListQuery;
  const context = getActorContextWithRole(req);
  const { items, meta } = await fundTransferService.listPendingApprovalsForStage("Verifier", context, query);
  sendSuccess(res, items, { meta, message: "Pending verifications retrieved successfully." });
}

export async function listPendingChecker(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferListQuery;
  const context = getActorContextWithRole(req);
  const { items, meta } = await fundTransferService.listPendingApprovalsForStage("Checker", context, query);
  sendSuccess(res, items, { meta, message: "Pending Checker approvals retrieved successfully." });
}

export async function bulkVerifyFundTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { ids, remarks } = res.locals.body as BulkFundTransferActionInput;
  const context = getActorContextWithRole(req);
  const result = await fundTransferService.bulkVerifyFundTransfers(ids, { remarks }, context);
  sendSuccess(res, result, { message: `${result.succeeded.length} verified, ${result.failed.length} failed.` });
}

export async function bulkApproveFundTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { ids, remarks } = res.locals.body as BulkFundTransferActionInput;
  const context = getActorContextWithRole(req);
  const result = await fundTransferService.bulkApproveFundTransfers(ids, { remarks }, context);
  sendSuccess(res, result, { message: `${result.succeeded.length} approved, ${result.failed.length} failed.` });
}

const CSV_HEADER = [
  "Transaction Type",
  "Date",
  "Financial Year",
  "Source Node",
  "Destination Node",
  "Scheme / Head",
  "Amount",
  "Reason",
  "Maker",
  "Status",
];

function writeCsvRows(res: Response, cursor: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const row of cursor) {
      const dto = fundTransferService.serializeFundTransferRowForExport(
        row as Parameters<typeof fundTransferService.serializeFundTransferRowForExport>[0]
      );
      res.write(
        toCsvRow([
          dto.transactionType,
          new Date(dto.createdAt).toISOString(),
          dto.financialYear?.financialYear ?? "",
          dto.sourceNode?.name ?? "",
          dto.destinationNode?.name ?? "",
          dto.head?.name ?? "",
          dto.amount,
          dto.reason,
          dto.maker?.fullname ?? "",
          dto.approvalStatus,
        ])
      );
    }
  })();
}

async function exportByType(req: AuthenticatedRequest, res: Response, transactionType: "PULL_FROM_CHILD" | "RETURN_TO_PARENT"): Promise<void> {
  const query = res.locals.query as FundTransferExportQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await fundTransferService.getAllowedNodeIdsForTransferModule(context);
  const cursor = fundTransferService.getFundTransfersCursorForExport({ ...query, transactionType }, allowedNodeIds);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${transactionType === "PULL_FROM_CHILD" ? "pull-funds" : "return-funds"}-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.write(toCsvRow(CSV_HEADER));
  await writeCsvRows(res, cursor);
  res.end();
}

export async function exportPullTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  await exportByType(req, res, "PULL_FROM_CHILD");
}

export async function exportReturnTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
  await exportByType(req, res, "RETURN_TO_PARENT");
}

export async function exportPendingVerification(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferExportQuery;
  const context = getActorContextWithRole(req);
  const cursor = await fundTransferService.getPendingApprovalsCursorForStage("Verifier", context, query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pending-fund-transfer-verification-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));
  if (cursor) await writeCsvRows(res, cursor);
  res.end();
}

export async function exportPendingChecker(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FundTransferExportQuery;
  const context = getActorContextWithRole(req);
  const cursor = await fundTransferService.getPendingApprovalsCursorForStage("Checker", context, query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pending-fund-transfer-checker-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));
  if (cursor) await writeCsvRows(res, cursor);
  res.end();
}
