import crypto from "crypto";
import Papa from "papaparse";
import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { toCsvRow } from "../../utils/csv";
import { BeneficiaryModel } from "../../models/fms/Beneficiary";
import { DeductionMasterModel } from "../../models/fms/DeductionMaster";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import { createPayrollBatch, type PayrollBatchDto } from "./payroll.service";
import { PAYROLL_MONTHS, type PayrollMonth } from "../../models/fms/PayrollBatch";
import type { CreatePayrollBatchInput } from "../../schemas/fms/payroll.schema";
import type { UserRole } from "../../models/User";

interface ActorContext {
  actorId: Types.ObjectId | null;
  actorRole?: UserRole;
  ipAddress: string | null;
  userAgent?: string | null;
}

export const PAYROLL_TEMPLATE_VERSION = "PAYROLL_V1";
const MAX_BULK_ROWS = 2000;

const STATIC_COLUMNS = [
  "Financial Year",
  "Scheme",
  "Month",
  "Organization Node",
  "Sanction Number",
  "Sanction Date",
  "Remarks",
  "Employee ID",
  "Employee Name",
  "Salary Amount",
] as const;

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(headerMap: Map<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const original = headerMap.get(candidate);
    if (original) return original;
  }
  return null;
}

async function getActiveEmployeeDeductions() {
  return DeductionMasterModel.find({ deductionType: "EMPLOYEE", isActive: true }).sort({ displayOrder: 1, name: 1 }).lean();
}

export async function generatePayrollBulkTemplateCsv(): Promise<string> {
  const deductions = await getActiveEmployeeDeductions();
  let csv = `Template Version: ${PAYROLL_TEMPLATE_VERSION}\r\n`;
  csv += toCsvRow([...STATIC_COLUMNS, ...deductions.map((d) => d.name)]);
  csv += toCsvRow(["2026-27", "Revenue Scheme", "April", "Tech Department", "SANCTION-001", "2026-04-01", "", "EMP-001", "Jane Doe", "50000", ...deductions.map(() => "")]);
  csv += toCsvRow(["", "", "", "", "", "", "", "EMP-002", "John Smith", "45000", ...deductions.map(() => "")]);
  return csv;
}

// ---------------------------------------------------------------------------
// Parsing — the shared Payroll Context (Financial Year/Scheme/Month/Org
// Node/Sanction/Remarks) is read from the first data row; later rows'
// blank context cells inherit it, a conflicting non-blank cell fails that
// row. One row per employee.
// ---------------------------------------------------------------------------

interface ParsedRow {
  csvRow: number;
  financialYear: string;
  scheme: string;
  month: string;
  organizationNode: string;
  sanctionNumber: string;
  sanctionDate: string;
  remarks: string;
  employeeId: string;
  employeeName: string;
  salaryAmount: string;
  deductionAmountsByName: Map<string, string>;
}

function parsePayrollBulkCsv(buffer: Buffer, deductionNames: string[]): ParsedRow[] {
  const text = buffer.toString("utf-8");
  const versionLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!versionLine.trim().toLowerCase().startsWith("template version")) {
    throw new AppError(422, "This file does not look like the Payroll Bulk Upload template — the Template Version marker row is missing.");
  }
  if (!versionLine.includes(PAYROLL_TEMPLATE_VERSION)) {
    throw new AppError(422, `This file was generated with an outdated template. Please download a fresh template (expected ${PAYROLL_TEMPLATE_VERSION}).`);
  }
  const csvBody = text.slice(text.indexOf("\n") + 1);

  const parsed = Papa.parse<Record<string, string>>(csvBody, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) throw new AppError(422, `Could not parse the CSV file: ${parsed.errors[0].message}`);
  const rawHeaders = parsed.meta.fields ?? [];
  if (rawHeaders.length === 0) throw new AppError(422, "The CSV file has no header row.");
  if (parsed.data.length === 0) throw new AppError(422, "The CSV file has no data rows.");
  if (parsed.data.length > MAX_BULK_ROWS) throw new AppError(422, `A single import is limited to ${MAX_BULK_ROWS} rows.`);

  const headerMap = new Map(rawHeaders.map((h) => [normalizeHeader(h), h]));
  const col = (candidates: string[]) => findColumn(headerMap, candidates);
  const financialYearCol = col(["financialyear"]);
  const schemeCol = col(["scheme"]);
  const monthCol = col(["month"]);
  const orgNodeCol = col(["organizationnode"]);
  const sanctionNumberCol = col(["sanctionnumber"]);
  const sanctionDateCol = col(["sanctiondate"]);
  const remarksCol = col(["remarks"]);
  const employeeIdCol = col(["employeeid"]);
  const employeeNameCol = col(["employeename"]);
  const salaryAmountCol = col(["salaryamount"]);
  if (!employeeIdCol) throw new AppError(422, 'The CSV must include an "Employee ID" column.');
  if (!salaryAmountCol) throw new AppError(422, 'The CSV must include a "Salary Amount" column.');

  const deductionColsByName = new Map<string, string>();
  for (const name of deductionNames) {
    const found = findColumn(headerMap, [normalizeHeader(name)]);
    if (found) deductionColsByName.set(name, found);
  }

  const get = (record: Record<string, string>, c: string | null) => (c ? (record[c] ?? "").trim() : "");

  return parsed.data.map((record, index) => {
    const deductionAmountsByName = new Map<string, string>();
    for (const [name, c] of deductionColsByName) deductionAmountsByName.set(name, get(record, c));
    return {
      csvRow: index + 3,
      financialYear: get(record, financialYearCol),
      scheme: get(record, schemeCol),
      month: get(record, monthCol),
      organizationNode: get(record, orgNodeCol),
      sanctionNumber: get(record, sanctionNumberCol),
      sanctionDate: get(record, sanctionDateCol),
      remarks: get(record, remarksCol),
      employeeId: get(record, employeeIdCol),
      employeeName: get(record, employeeNameCol),
      salaryAmount: get(record, salaryAmountCol),
      deductionAmountsByName,
    };
  });
}

/** Thrown by mergeContextField and caught in resolvePayrollContext — lets the merge+validate code below read plain strings instead of a result union. */
class ContextValidationError extends Error {}

/** Blank cells in a later row inherit the first row's value; a non-blank conflicting value fails that row. */
function mergeContextField(first: string, rows: ParsedRow[], field: keyof ParsedRow): string {
  for (const row of rows.slice(1)) {
    const value = row[field];
    if (typeof value === "string" && value && value !== first) {
      throw new ContextValidationError(`Row ${row.csvRow}: "${String(field)}" conflicts with the shared Payroll Context from the first row.`);
    }
  }
  return first;
}

// ---------------------------------------------------------------------------
// Master-reference resolution
// ---------------------------------------------------------------------------

interface MasterCaches {
  orgNodesByName: Map<string, { _id: Types.ObjectId; parentNodeId: Types.ObjectId | null }>;
  orgNodesById: Map<string, { parentNodeId: Types.ObjectId | null }>;
  financialYearsByLabel: Map<string, Types.ObjectId>;
  schemeRootsByName: Map<string, Types.ObjectId>;
  employeeDeductionsByName: Map<string, { _id: Types.ObjectId }>;
}

async function buildMasterCaches(): Promise<MasterCaches> {
  const [orgNodes, financialYears, schemeHeadNodes, employeeDeductions] = await Promise.all([
    OrganizationNodeModel.find({ status: "Active" }).select("name parentNodeId").lean(),
    FinancialYearModel.find().select("financialYear").lean(),
    SchemeHeadNodeModel.find({ status: "Active", parentNodeId: null }).select("name").lean(),
    getActiveEmployeeDeductions(),
  ]);

  const orgNodesByName = new Map<string, { _id: Types.ObjectId; parentNodeId: Types.ObjectId | null }>();
  const orgNodesById = new Map<string, { parentNodeId: Types.ObjectId | null }>();
  for (const n of orgNodes) {
    orgNodesByName.set(n.name.trim().toLowerCase(), { _id: n._id, parentNodeId: n.parentNodeId ?? null });
    orgNodesById.set(String(n._id), { parentNodeId: n.parentNodeId ?? null });
  }

  return {
    orgNodesByName,
    orgNodesById,
    financialYearsByLabel: new Map(financialYears.map((y) => [y.financialYear, y._id])),
    schemeRootsByName: new Map(schemeHeadNodes.map((n) => [n.name.trim().toLowerCase(), n._id])),
    employeeDeductionsByName: new Map(employeeDeductions.map((d) => [d.name.trim().toLowerCase(), { _id: d._id }])),
  };
}

async function resolveOrganizationRoot(nodeId: Types.ObjectId, caches: MasterCaches): Promise<Types.ObjectId> {
  let current = caches.orgNodesById.get(String(nodeId));
  let currentId = nodeId;
  const visited = new Set<string>();
  while (current?.parentNodeId) {
    if (visited.has(String(currentId))) throw new AppError(422, "Organization Node hierarchy has a cycle.");
    visited.add(String(currentId));
    currentId = current.parentNodeId;
    current = caches.orgNodesById.get(String(currentId));
  }
  return currentId;
}

interface ResolvedContextError {
  ok: false;
  error: string;
}
interface ResolvedContextSuccess {
  ok: true;
  context: {
    financialYearId: Types.ObjectId;
    organizationRootNodeId: Types.ObjectId;
    organizationNodeId: Types.ObjectId;
    schemeHeadRootNodeId: Types.ObjectId;
    month: PayrollMonth;
    sanctionNumber: string;
    sanctionDate: string;
    remarks: string;
  };
}

async function resolvePayrollContextOrThrow(rows: ParsedRow[], caches: MasterCaches): Promise<ResolvedContextSuccess["context"]> {
  const first = rows[0];
  const financialYear = mergeContextField(first.financialYear, rows, "financialYear");
  const scheme = mergeContextField(first.scheme, rows, "scheme");
  const month = mergeContextField(first.month, rows, "month");
  const organizationNode = mergeContextField(first.organizationNode, rows, "organizationNode");
  const sanctionNumber = mergeContextField(first.sanctionNumber, rows, "sanctionNumber");
  const sanctionDate = mergeContextField(first.sanctionDate, rows, "sanctionDate");
  const remarks = mergeContextField(first.remarks, rows, "remarks");

  function fail(message: string): never {
    throw new ContextValidationError(message);
  }

  if (!financialYear) fail("Financial Year is required.");
  if (!scheme) fail("Scheme is required.");
  if (!month || !(PAYROLL_MONTHS as readonly string[]).includes(month)) fail(`Month "${month}" is invalid — expected one of ${PAYROLL_MONTHS.join(", ")}.`);
  if (!organizationNode) fail("Organization Node is required.");

  const financialYearId = caches.financialYearsByLabel.get(financialYear);
  if (!financialYearId) fail(`Unknown Financial Year "${financialYear}".`);

  const orgNode = caches.orgNodesByName.get(organizationNode.trim().toLowerCase());
  if (!orgNode) fail(`Unknown or inactive Organization Node "${organizationNode}".`);
  const organizationRootNodeId = await resolveOrganizationRoot(orgNode._id, caches);

  const schemeRootId = caches.schemeRootsByName.get(scheme.trim().toLowerCase());
  if (!schemeRootId) fail(`Unknown or non-root Scheme "${scheme}".`);

  return {
    financialYearId,
    organizationRootNodeId,
    organizationNodeId: orgNode._id,
    schemeHeadRootNodeId: schemeRootId,
    month: month as PayrollMonth,
    sanctionNumber,
    sanctionDate,
    remarks,
  };
}

async function resolvePayrollContext(rows: ParsedRow[], caches: MasterCaches): Promise<ResolvedContextError | ResolvedContextSuccess> {
  try {
    const context = await resolvePayrollContextOrThrow(rows, caches);
    return { ok: true, context };
  } catch (error) {
    if (error instanceof ContextValidationError) return { ok: false, error: error.message };
    throw error;
  }
}

interface ResolvedEmployeeError {
  ok: false;
  row: number;
  employeeId: string;
  error: string;
}
interface ResolvedEmployeeSuccess {
  ok: true;
  row: number;
  employeeId: string;
  input: { beneficiaryId: string; salaryAmount: number; deductions: Array<{ deductionId: string; amount: number }> };
}

async function resolvePayrollEmployeeRow(
  row: ParsedRow,
  caches: MasterCaches,
  seenEmployeeIds: Set<string>
): Promise<ResolvedEmployeeError | ResolvedEmployeeSuccess> {
  if (!row.employeeId) return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: "Employee ID is required." };
  if (seenEmployeeIds.has(row.employeeId)) {
    return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `Duplicate Employee ID "${row.employeeId}" within this file.` };
  }
  seenEmployeeIds.add(row.employeeId);

  const salaryAmount = Number(row.salaryAmount);
  if (!Number.isFinite(salaryAmount) || salaryAmount <= 0) {
    return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: "Salary Amount must be a positive number." };
  }

  const beneficiary = await BeneficiaryModel.findOne({ employeeId: row.employeeId, beneficiaryType: "EMPLOYEE" }).select("_id name isActive bankAccounts");
  if (!beneficiary) return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `Employee ID "${row.employeeId}" not found.` };
  if (!beneficiary.isActive) return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `"${beneficiary.name}" is not an active Employee.` };
  if (!beneficiary.bankAccounts.some((b) => b.isDefault)) {
    return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `"${beneficiary.name}" has no Default Bank Account on file.` };
  }

  const deductions: Array<{ deductionId: string; amount: number }> = [];
  for (const [name, raw] of row.deductionAmountsByName) {
    if (!raw) continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `Deduction "${name}" has an invalid amount.` };
    }
    const doc = caches.employeeDeductionsByName.get(name.trim().toLowerCase());
    if (!doc) return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: `Deduction "${name}" is no longer an Active Employee deduction.` };
    deductions.push({ deductionId: String(doc._id), amount });
  }
  const totalDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);
  if (totalDeduction > salaryAmount) {
    return { ok: false, row: row.csvRow, employeeId: row.employeeId, error: "Total Deductions exceed the Salary Amount." };
  }

  return { ok: true, row: row.csvRow, employeeId: row.employeeId, input: { beneficiaryId: String(beneficiary._id), salaryAmount, deductions } };
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

export interface PayrollBulkUploadRowResult {
  row: number;
  employeeId: string;
  status: "valid" | "created" | "failed";
  message?: string;
}

export interface PayrollBulkUploadResult {
  dryRun: boolean;
  batchReference: string;
  contextError?: string;
  summary: { totalEmployees: number; valid: number; failed: number };
  rows: PayrollBulkUploadRowResult[];
  payrollBatch?: PayrollBatchDto;
}

async function runPayrollBulkUpload(buffer: Buffer, context: ActorContext, dryRun: boolean, fileName?: string): Promise<PayrollBulkUploadResult> {
  const batchReference = crypto.randomUUID();
  const actorId = context.actorId;

  await logActivity({
    user: actorId,
    action: "PAYROLL_BULK_UPLOAD_STARTED",
    module: "FINANCE",
    description: `Payroll bulk upload started${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}, ${dryRun ? "preview" : "commit"}).`,
    entityType: "PayrollBatch",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const deductions = await getActiveEmployeeDeductions();
  const rows = parsePayrollBulkCsv(buffer, deductions.map((d) => d.name));
  const caches = await buildMasterCaches();

  const resolvedContext = await resolvePayrollContext(rows, caches);
  if (!resolvedContext.ok) {
    await logActivity({
      user: actorId,
      action: "PAYROLL_BULK_UPLOAD_FAILED",
      module: "FINANCE",
      description: `Payroll bulk upload failed${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}): ${resolvedContext.error}`,
      entityType: "PayrollBatch",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return {
      dryRun,
      batchReference,
      contextError: resolvedContext.error,
      summary: { totalEmployees: rows.length, valid: 0, failed: rows.length },
      rows: rows.map((r) => ({ row: r.csvRow, employeeId: r.employeeId, status: "failed", message: "Skipped — the shared Payroll Context is invalid." })),
    };
  }

  const seenEmployeeIds = new Set<string>();
  const rowResults: PayrollBulkUploadRowResult[] = [];
  const validEmployeeInputs: Array<{ beneficiaryId: string; salaryAmount: number; deductions: Array<{ deductionId: string; amount: number }> }> = [];

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolvePayrollEmployeeRow(row, caches, seenEmployeeIds);
    if (!resolved.ok) {
      rowResults.push({ row: resolved.row, employeeId: resolved.employeeId, status: "failed", message: resolved.error });
      continue;
    }
    validEmployeeInputs.push(resolved.input);
    rowResults.push({ row: resolved.row, employeeId: resolved.employeeId, status: dryRun ? "valid" : "created" });
  }

  const validCount = validEmployeeInputs.length;
  const failedCount = rowResults.length - validCount;

  if (dryRun || validCount === 0) {
    if (!dryRun && validCount === 0) {
      await logActivity({
        user: actorId,
        action: "PAYROLL_BULK_UPLOAD_FAILED",
        module: "FINANCE",
        description: `Payroll bulk upload failed${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}): no valid employee rows.`,
        entityType: "PayrollBatch",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
    } else {
      await logActivity({
        user: actorId,
        action: "PAYROLL_BULK_UPLOAD_VALIDATION_COMPLETED",
        module: "FINANCE",
        description: `Payroll bulk upload validated${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}): ${validCount} valid, ${failedCount} failed.`,
        entityType: "PayrollBatch",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
    }
    return { dryRun, batchReference, summary: { totalEmployees: rows.length, valid: validCount, failed: failedCount }, rows: rowResults };
  }

  const input: CreatePayrollBatchInput = {
    financialYearId: String(resolvedContext.context.financialYearId),
    organizationRootNodeId: String(resolvedContext.context.organizationRootNodeId),
    organizationNodeId: String(resolvedContext.context.organizationNodeId),
    schemeHeadRootNodeId: String(resolvedContext.context.schemeHeadRootNodeId),
    month: resolvedContext.context.month,
    sanctionNumber: resolvedContext.context.sanctionNumber || undefined,
    sanctionDate: resolvedContext.context.sanctionDate ? new Date(resolvedContext.context.sanctionDate) : undefined,
    remarks: resolvedContext.context.remarks || undefined,
    employees: validEmployeeInputs,
  };

  try {
    const created = await createPayrollBatch(input, context);
    await logActivity({
      user: actorId,
      action: "PAYROLL_BULK_UPLOAD_IMPORTED",
      module: "FINANCE",
      description: `Payroll bulk upload completed${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}): created ${created.payrollNumber} with ${validCount} employee(s), ${failedCount} skipped, total ${created.totalGrossSalary}.`,
      entityType: "PayrollBatch",
      entityId: Types.ObjectId.isValid(created._id) ? new Types.ObjectId(created._id) : null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return {
      dryRun,
      batchReference,
      summary: { totalEmployees: rows.length, valid: validCount, failed: failedCount },
      rows: rowResults,
      payrollBatch: created,
    };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Failed to create the Payroll batch.";
    await logActivity({
      user: actorId,
      action: "PAYROLL_BULK_UPLOAD_FAILED",
      module: "FINANCE",
      description: `Payroll bulk upload failed${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}): ${message}`,
      entityType: "PayrollBatch",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return {
      dryRun,
      batchReference,
      contextError: message,
      summary: { totalEmployees: rows.length, valid: 0, failed: rows.length },
      rows: rowResults.map((r) => ({ ...r, status: "failed", message: r.status === "failed" ? r.message : message })),
    };
  }
}

export async function previewPayrollBulkUpload(buffer: Buffer, context: ActorContext, fileName?: string): Promise<PayrollBulkUploadResult> {
  return runPayrollBulkUpload(buffer, context, true, fileName);
}

export async function commitPayrollBulkUpload(buffer: Buffer, context: ActorContext, fileName?: string): Promise<PayrollBulkUploadResult> {
  return runPayrollBulkUpload(buffer, context, false, fileName);
}
