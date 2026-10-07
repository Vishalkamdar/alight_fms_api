import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { uploadCsv } from "../../utils/fms/upload";
import * as bulkUploadService from "../../services/fms/payroll-bulk-upload.service";
import type { AuthenticatedRequest } from "../../middleware/auth";

export async function downloadPayrollBulkTemplate(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const csv = await bulkUploadService.generatePayrollBulkTemplateCsv();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="payroll-bulk-upload-template.csv"');
  res.send(csv);
}

export async function bulkUploadPayroll(req: AuthenticatedRequest, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    uploadCsv(req, res, (err: unknown) => {
      if (err) {
        reject(new AppError(400, err instanceof Error ? err.message : "Failed to read the CSV file."));
        return;
      }
      resolve();
    });
  });

  if (!req.file) throw new AppError(400, "A CSV file is required.");

  const dryRun = req.query.commit !== "true";
  const context = getActorContextWithRole(req);

  const result = dryRun
    ? await bulkUploadService.previewPayrollBulkUpload(req.file.buffer, context, req.file.originalname)
    : await bulkUploadService.commitPayrollBulkUpload(req.file.buffer, context, req.file.originalname);

  sendSuccess(res, result, {
    message: dryRun
      ? "Preview generated — nothing has been imported yet."
      : result.payrollBatch
        ? `Import complete — Payroll batch ${result.payrollBatch.payrollNumber} created with ${result.summary.valid} employee(s), ${result.summary.failed} skipped.`
        : `Import failed — ${result.contextError ?? "see row errors below."}`,
  });
}
