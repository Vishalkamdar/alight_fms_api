import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import { AppError } from "../../utils/AppError";
import { toCsvRow } from "../../utils/csv";
import { uploadCsv } from "../../utils/fms/upload";
import { getAllowedNodeIdsForList } from "../../services/fms/financial-workflow.service";
import { getMyAllocatableNodes } from "../../services/fms/budget-allocation.service";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import * as beneficiaryService from "../../services/fms/beneficiary.service";
import type { BeneficiaryType } from "../../models/fms/Beneficiary";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  BeneficiaryExportQuery,
  BeneficiaryListQuery,
  CreateBeneficiaryInput,
  UpdateBeneficiaryInput,
} from "../../schemas/fms/beneficiary.schema";

/**
 * Every Department a Maker may assign a Vendor/Employee to right now — the
 * exact same node-scoping mechanism already built for Budget Allocation
 * (getAllowedNodeIdsForList → the Maker's own assigned node(s) plus any
 * descendant they govern), reused here rather than duplicated. `null`
 * means unrestricted (Super Admin/Admin), who get a "Global" option plus
 * the full Organization Tree on the frontend instead.
 */
export async function getMyDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
  const context = getActorContextWithRole(req);
  const nodes = await getMyAllocatableNodes(context);
  sendSuccess(res, nodes);
}

export async function listBeneficiaries(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BeneficiaryListQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const { items, meta } = await beneficiaryService.listBeneficiaries(query, allowedNodeIds);
  sendSuccess(res, items, { meta, message: "Beneficiaries retrieved successfully." });
}

export async function getBeneficiary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const beneficiary = await beneficiaryService.getBeneficiaryById(id, allowedNodeIds);
  sendSuccess(res, beneficiary);
}

export async function createBeneficiary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateBeneficiaryInput;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const beneficiary = await beneficiaryService.createBeneficiary(body, { ...context, allowedNodeIds });
  sendSuccess(res, beneficiary, { statusCode: 201, message: "Beneficiary created." });
}

export async function updateBeneficiary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateBeneficiaryInput;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const beneficiary = await beneficiaryService.updateBeneficiary(id, body, { ...context, allowedNodeIds });
  sendSuccess(res, beneficiary, { message: "Beneficiary updated." });
}

export async function setBeneficiaryActive(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { isActive } = res.locals.body as { isActive: boolean };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const beneficiary = await beneficiaryService.setBeneficiaryActive(id, isActive, { ...context, allowedNodeIds });
  sendSuccess(res, beneficiary, { message: isActive ? "Beneficiary activated." : "Beneficiary deactivated." });
}

export async function deleteBeneficiary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  await beneficiaryService.deleteBeneficiary(id, { ...context, allowedNodeIds });
  sendSuccess(res, null, { message: "Beneficiary deleted." });
}

const CSV_HEADER = [
  "Beneficiary Type",
  "Department",
  "Name",
  "Employee ID",
  "PAN",
  "GST",
  "Mobile",
  "State",
  "Default Bank",
  "Status",
  "Created Date",
];

export async function exportBeneficiaries(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as BeneficiaryExportQuery;
  const context = getActorContextWithRole(req);
  const allowedNodeIds = await getAllowedNodeIdsForList(context);
  const cursor = beneficiaryService.getBeneficiariesCursorForExport(query, allowedNodeIds);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="beneficiaries-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(toCsvRow(CSV_HEADER));

  // Cached per-export rather than one query per row — most rows share a
  // handful of departments.
  const nodeNameCache = new Map<string, string>();
  async function departmentLabel(nodeId: unknown): Promise<string> {
    if (!nodeId) return "Global";
    const key = String(nodeId);
    if (!nodeNameCache.has(key)) {
      const node = await OrganizationNodeModel.findById(key).select("name").lean();
      nodeNameCache.set(key, node?.name ?? "");
    }
    return nodeNameCache.get(key) ?? "";
  }

  for await (const doc of cursor) {
    const defaultBank = doc.bankAccounts.find((b) => b.isDefault);
    res.write(
      toCsvRow([
        doc.beneficiaryType,
        await departmentLabel(doc.organizationNodeId),
        doc.name,
        doc.employeeId ?? "",
        doc.panNumber ?? "",
        doc.beneficiaryType === "VENDOR" ? (doc.gstNumber ?? "") : "N/A",
        doc.mobile,
        doc.state ?? "",
        defaultBank ? `${defaultBank.bankName} ••${defaultBank.accountNumber.slice(-4)}` : doc.paymentMode === "CASH" ? "Cash" : "",
        doc.isActive ? "Active" : "Inactive",
        new Date(doc.createdAt).toISOString(),
      ])
    );
  }
  res.end();
}

async function handleBulkImport(req: AuthenticatedRequest, res: Response, beneficiaryType: BeneficiaryType): Promise<void> {
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
  const allowedNodeIds = await getAllowedNodeIdsForList(context);

  const result = await beneficiaryService.bulkImportBeneficiaries(
    beneficiaryType,
    req.file.buffer,
    context.actorId,
    allowedNodeIds,
    { ipAddress: context.ipAddress, userAgent: context.userAgent, fileName: req.file.originalname },
    dryRun
  );

  sendSuccess(res, result, {
    message: dryRun
      ? "Preview generated — nothing has been imported yet."
      : `Import complete — ${result.summary.created} created, ${result.summary.failed} failed.`,
  });
}

export async function bulkImportVendors(req: AuthenticatedRequest, res: Response): Promise<void> {
  await handleBulkImport(req, res, "VENDOR");
}

export async function bulkImportEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
  await handleBulkImport(req, res, "EMPLOYEE");
}
