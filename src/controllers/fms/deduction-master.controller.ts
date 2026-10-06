import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import { toCsvRow } from "../../utils/csv";
import * as deductionMasterService from "../../services/fms/deduction-master.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateDeductionMasterInput,
  DeductionMasterExportQuery,
  DeductionMasterListQuery,
  UpdateDeductionMasterInput,
} from "../../schemas/fms/deduction-master.schema";

export async function listDeductionMasters(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as DeductionMasterListQuery;
  const { items, meta } = await deductionMasterService.listDeductionMasters(query);
  sendSuccess(res, items, { meta, message: "Deductions retrieved successfully." });
}

export async function getDeductionMaster(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const deduction = await deductionMasterService.getDeductionMasterById(id);
  sendSuccess(res, deduction);
}

export async function createDeductionMaster(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateDeductionMasterInput;
  const context = getActorContext(req);
  const deduction = await deductionMasterService.createDeductionMaster(body, context);
  sendSuccess(res, deduction, { statusCode: 201, message: "Deduction created." });
}

export async function updateDeductionMaster(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateDeductionMasterInput;
  const context = getActorContext(req);
  const deduction = await deductionMasterService.updateDeductionMaster(id, body, context);
  sendSuccess(res, deduction, { message: "Deduction updated." });
}

export async function setDeductionMasterActive(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { isActive } = res.locals.body as { isActive: boolean };
  const context = getActorContext(req);
  const deduction = await deductionMasterService.setDeductionMasterActive(id, isActive, context);
  sendSuccess(res, deduction, { message: isActive ? "Deduction activated." : "Deduction deactivated." });
}

export async function deleteDeductionMaster(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  await deductionMasterService.deleteDeductionMaster(id, context);
  sendSuccess(res, null, { message: "Deduction deleted." });
}

const CSV_HEADER = ["Deduction Name", "Deduction Type", "Calculation Type", "Default Percentage", "Default Amount", "Status", "Display Order", "Created Date"];

export async function exportDeductionMasters(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as DeductionMasterExportQuery;
  const cursor = deductionMasterService.getDeductionMastersCursorForExport(query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="deduction-master-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));

  for await (const doc of cursor) {
    res.write(
      toCsvRow([
        doc.name,
        doc.deductionType === "VENDOR" ? "Vendor" : "Employee",
        doc.calculationType === "PERCENTAGE" ? "Percentage" : "Fixed Amount",
        doc.defaultPercentage !== null ? `${doc.defaultPercentage}%` : "",
        doc.defaultAmount !== null ? String(doc.defaultAmount) : "",
        doc.isActive ? "Active" : "Inactive",
        String(doc.displayOrder),
        new Date(doc.createdAt).toISOString(),
      ])
    );
  }
  res.end();
}
