import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as financialYearService from "../../services/fms/financial-year.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateFinancialYearInput,
  EnablePreviousYearEntryInput,
  FinancialYearListQuery,
  ReopenFinancialYearInput,
  UpdateFinancialYearInput,
} from "../../schemas/fms/financial-year.schema";
import type { FinancialYearStatus } from "../../models/fms/FinancialYear";

export async function listFinancialYears(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as FinancialYearListQuery;
  const { items, meta } = await financialYearService.listFinancialYears(query);
  sendSuccess(res, items, { meta, message: "Financial Years retrieved successfully." });
}

export async function getCurrentFinancialYear(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const year = await financialYearService.getCurrentFinancialYearDto();
  sendSuccess(res, year);
}

export async function getFinancialYear(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const year = await financialYearService.getFinancialYearById(id);
  sendSuccess(res, year);
}

export async function createFinancialYear(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateFinancialYearInput;
  const context = getActorContext(req);
  const year = await financialYearService.createFinancialYear(body, context);
  sendSuccess(res, year, { statusCode: 201, message: "Financial Year created." });
}

export async function updateFinancialYear(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateFinancialYearInput;
  const context = getActorContext(req);
  const year = await financialYearService.updateFinancialYear(id, body, context);
  sendSuccess(res, year, { message: "Financial Year updated." });
}

export async function updateFinancialYearStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { status } = res.locals.body as { status: FinancialYearStatus };
  const context = getActorContext(req);
  const year = await financialYearService.updateFinancialYearStatus(id, status, context);
  sendSuccess(res, year, { message: "Financial Year status updated." });
}

export async function enablePreviousYearEntry(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { enabled } = res.locals.body as EnablePreviousYearEntryInput;
  const context = getActorContext(req);
  const year = await financialYearService.setPreviousYearEntryAllowed(id, enabled, context);
  sendSuccess(res, year, {
    message: `Previous-year entry ${enabled ? "enabled" : "disabled"} for "${year.financialYear}".`,
  });
}

export async function closeBooks(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  // Body only carries { confirm: true }, already enforced by validate() — nothing else to read.
  const context = getActorContext(req);
  const year = await financialYearService.closeBooks(id, context);
  sendSuccess(res, year, { message: `Financial Year "${year.financialYear}" closed.` });
}

export async function reopenFinancialYear(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { reason } = res.locals.body as ReopenFinancialYearInput;
  const context = getActorContext(req);
  const year = await financialYearService.reopenFinancialYear(id, reason, context);
  sendSuccess(res, year, { message: `Financial Year "${year.financialYear}" reopened.` });
}

export async function getClosingSummary(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const summary = await financialYearService.getClosingSummary(id);
  sendSuccess(res, summary);
}

export async function getDepartmentSummary(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const rows = await financialYearService.getDepartmentSummary(id);
  sendSuccess(res, rows);
}
