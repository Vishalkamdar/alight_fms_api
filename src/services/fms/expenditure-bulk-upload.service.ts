import crypto from "crypto";
import Papa from "papaparse";
import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import { toCsvRow } from "../../utils/csv";
import { BeneficiaryModel, type BeneficiaryType } from "../../models/fms/Beneficiary";
import { DeductionMasterModel } from "../../models/fms/DeductionMaster";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";
import { FinancialYearModel } from "../../models/fms/FinancialYear";
import { createExpenditure, type ExpenditureDto } from "./expenditure.service";
import { EXPENDITURE_PAYMENT_TYPES } from "../../models/fms/Expenditure";
import { CGST_SGST_SLABS, IGST_SLABS, type CreateExpenditureInput } from "../../schemas/fms/expenditure.schema";
import type { UserRole } from "../../models/User";

interface ActorContext {
  actorId: Types.ObjectId | null;
  actorRole?: UserRole;
  ipAddress: string | null;
  userAgent?: string | null;
}

export const EXPENDITURE_TEMPLATE_VERSION = "EXPENDITURE_V1";
const MAX_BULK_ROWS = 2000;

const STATIC_COLUMNS = [
  "Expenditure Reference",
  "Financial Year",
  "Payment Type",
  "Bill/Voucher Number",
  "Bill/Voucher Date",
  "Organization Node",
  "Beneficiary Type",
  "Beneficiary",
  "Beneficiary ID",
  "Scheme",
  "Head",
  "Debit Narration",
  "Credit Narration",
  "Remarks",
  "Enrichment 1",
  "Enrichment 2",
  "CGST %",
  "IGST %",
  "Particular",
  "Particular Amount",
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

async function getActiveVendorDeductions() {
  return DeductionMasterModel.find({ deductionType: "VENDOR", isActive: true }).sort({ displayOrder: 1, name: 1 }).lean();
}

export async function generateExpenditureBulkTemplateCsv(): Promise<string> {
  const deductions = await getActiveVendorDeductions();
  let csv = `Template Version: ${EXPENDITURE_TEMPLATE_VERSION}\r\n`;
  csv += toCsvRow([...STATIC_COLUMNS, ...deductions.map((d) => d.name)]);
  csv += toCsvRow([
    "EXP-001",
    "2026-27",
    "ONLINE",
    "BILL-001",
    "2026-04-15",
    "Tech Department",
    "VENDOR",
    "Acme Hosting Pvt Ltd",
    "",
    "Capital Scheme",
    "IT Equipment",
    "",
    "",
    "",
    "",
    "",
    "9",
    "0",
    "Hosting",
    "25000",
    ...deductions.map(() => ""),
  ]);
  csv += toCsvRow([
    "EXP-001",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "Backup",
    "5000",
    ...deductions.map(() => ""),
  ]);
  return csv;
}

// ---------------------------------------------------------------------------
// Parsing — groups rows by "Expenditure Reference" in file order. The first
// row of a group carries the header-level fields; later rows only need
// Reference + Particular + Amount (blank header cells inherit the first
// row's value, a conflicting non-blank cell fails the group).
// ---------------------------------------------------------------------------

interface ParsedRow {
  csvRow: number;
  reference: string;
  financialYear: string;
  paymentType: string;
  billVoucherNumber: string;
  billVoucherDate: string;
  organizationNode: string;
  beneficiaryType: string;
  beneficiary: string;
  beneficiaryId: string;
  scheme: string;
  head: string;
  debitNarration: string;
  creditNarration: string;
  remarks: string;
  enrichment1: string;
  enrichment2: string;
  cgstPercent: string;
  igstPercent: string;
  particular: string;
  amount: string;
  deductionAmountsByName: Map<string, string>;
}

interface ParsedGroup {
  reference: string;
  firstCsvRow: number;
  rows: ParsedRow[];
}

function parseExpenditureBulkCsv(buffer: Buffer, deductionNames: string[]): ParsedGroup[] {
  const text = buffer.toString("utf-8");
  const versionLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!versionLine.trim().toLowerCase().startsWith("template version")) {
    throw new AppError(422, "This file does not look like the Expenditure Bulk Upload template — the Template Version marker row is missing.");
  }
  if (!versionLine.includes(EXPENDITURE_TEMPLATE_VERSION)) {
    throw new AppError(422, `This file was generated with an outdated template. Please download a fresh template (expected ${EXPENDITURE_TEMPLATE_VERSION}).`);
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
  const referenceCol = col(["expenditurereference", "reference"]);
  if (!referenceCol) throw new AppError(422, 'The CSV must include an "Expenditure Reference" column.');
  const particularCol = col(["particular", "particulardescription", "description"]);
  const amountCol = col(["particularamount", "amount"]);
  if (!particularCol || !amountCol) throw new AppError(422, 'The CSV must include "Particular" and "Particular Amount" columns.');

  const financialYearCol = col(["financialyear"]);
  const paymentTypeCol = col(["paymenttype"]);
  const billNumberCol = col(["billvouchernumber"]);
  const billDateCol = col(["billvoucherdate"]);
  const orgNodeCol = col(["organizationnode"]);
  const beneficiaryTypeCol = col(["beneficiarytype"]);
  const beneficiaryCol = col(["beneficiary"]);
  const beneficiaryIdCol = col(["beneficiaryid"]);
  const schemeCol = col(["scheme"]);
  const headCol = col(["head"]);
  const debitNarrationCol = col(["debitnarration"]);
  const creditNarrationCol = col(["creditnarration"]);
  const remarksCol = col(["remarks"]);
  const enrichment1Col = col(["enrichment1"]);
  const enrichment2Col = col(["enrichment2"]);
  const cgstCol = col(["cgst", "cgstpercent"]);
  const igstCol = col(["igst", "igstpercent"]);

  const deductionColsByName = new Map<string, string>();
  for (const name of deductionNames) {
    const found = findColumn(headerMap, [normalizeHeader(name)]);
    if (found) deductionColsByName.set(name, found);
  }

  const get = (record: Record<string, string>, c: string | null) => (c ? (record[c] ?? "").trim() : "");

  const groups = new Map<string, ParsedGroup>();
  const order: string[] = [];
  parsed.data.forEach((record, index) => {
    const csvRow = index + 3; // +1 header already skipped as version line, +1 for 1-index, +1 for header row itself
    const reference = get(record, referenceCol);
    if (!reference) throw new AppError(422, `Row ${csvRow}: "Expenditure Reference" is required.`);

    const deductionAmountsByName = new Map<string, string>();
    for (const [name, c] of deductionColsByName) deductionAmountsByName.set(name, get(record, c));

    const row: ParsedRow = {
      csvRow,
      reference,
      financialYear: get(record, financialYearCol),
      paymentType: get(record, paymentTypeCol),
      billVoucherNumber: get(record, billNumberCol),
      billVoucherDate: get(record, billDateCol),
      organizationNode: get(record, orgNodeCol),
      beneficiaryType: get(record, beneficiaryTypeCol).toUpperCase(),
      beneficiary: get(record, beneficiaryCol),
      beneficiaryId: get(record, beneficiaryIdCol),
      scheme: get(record, schemeCol),
      head: get(record, headCol),
      debitNarration: get(record, debitNarrationCol),
      creditNarration: get(record, creditNarrationCol),
      remarks: get(record, remarksCol),
      enrichment1: get(record, enrichment1Col),
      enrichment2: get(record, enrichment2Col),
      cgstPercent: get(record, cgstCol),
      igstPercent: get(record, igstCol),
      particular: get(record, particularCol),
      amount: get(record, amountCol),
      deductionAmountsByName,
    };

    if (!groups.has(reference)) {
      groups.set(reference, { reference, firstCsvRow: csvRow, rows: [] });
      order.push(reference);
    }
    groups.get(reference)!.rows.push(row);
  });

  return order.map((reference) => groups.get(reference)!);
}

/** Thrown by mergeHeaderField and caught in resolveExpenditureGroup — lets the merge+validate code below read plain strings instead of a result union, while still reporting a row-level message per failed group. */
class GroupValidationError extends Error {}

/** Blank cells in a continuation row inherit the first row's value; a non-blank conflicting value fails the group. */
function mergeHeaderField(first: string, rows: ParsedRow[], field: keyof ParsedRow): string {
  for (const row of rows.slice(1)) {
    const value = row[field];
    if (typeof value === "string" && value && value !== first) {
      throw new GroupValidationError(`Row ${row.csvRow}: "${String(field)}" conflicts with the first row of this Expenditure Reference.`);
    }
  }
  return first;
}

// ---------------------------------------------------------------------------
// Resolution — master-reference names → ids, re-running the same shape of
// checks createExpenditure() itself re-validates, so a bad row fails fast
// here rather than only at the real creation call.
// ---------------------------------------------------------------------------

interface MasterCaches {
  orgNodesByName: Map<string, { _id: Types.ObjectId; parentNodeId: Types.ObjectId | null; status: string }>;
  orgNodesById: Map<string, { parentNodeId: Types.ObjectId | null; status: string }>;
  financialYearsByLabel: Map<string, Types.ObjectId>;
  schemeRootsByName: Map<string, Types.ObjectId>;
  headsByNameUnderRoot: Map<string, Array<{ _id: Types.ObjectId; hierarchyPath: string }>>;
  vendorDeductionsByName: Map<string, { _id: Types.ObjectId }>;
}

async function buildMasterCaches(): Promise<MasterCaches> {
  const [orgNodes, financialYears, schemeHeadNodes, vendorDeductions] = await Promise.all([
    OrganizationNodeModel.find({ status: "Active" }).select("name parentNodeId status").lean(),
    FinancialYearModel.find().select("financialYear").lean(),
    SchemeHeadNodeModel.find({ status: "Active" }).select("name parentNodeId hierarchyPath").lean(),
    getActiveVendorDeductions(),
  ]);

  const orgNodesByName = new Map<string, { _id: Types.ObjectId; parentNodeId: Types.ObjectId | null; status: string }>();
  const orgNodesById = new Map<string, { parentNodeId: Types.ObjectId | null; status: string }>();
  for (const n of orgNodes) {
    orgNodesByName.set(n.name.trim().toLowerCase(), { _id: n._id, parentNodeId: n.parentNodeId ?? null, status: "Active" });
    orgNodesById.set(String(n._id), { parentNodeId: n.parentNodeId ?? null, status: "Active" });
  }

  const schemeRootsByName = new Map<string, Types.ObjectId>();
  const headsByNameUnderRoot = new Map<string, Array<{ _id: Types.ObjectId; hierarchyPath: string }>>();
  for (const n of schemeHeadNodes) {
    if (!n.parentNodeId) schemeRootsByName.set(n.name.trim().toLowerCase(), n._id);
    const key = n.name.trim().toLowerCase();
    if (!headsByNameUnderRoot.has(key)) headsByNameUnderRoot.set(key, []);
    headsByNameUnderRoot.get(key)!.push({ _id: n._id, hierarchyPath: n.hierarchyPath });
  }

  return {
    orgNodesByName,
    orgNodesById,
    financialYearsByLabel: new Map(financialYears.map((y) => [y.financialYear, y._id])),
    schemeRootsByName,
    headsByNameUnderRoot,
    vendorDeductionsByName: new Map(vendorDeductions.map((d) => [d.name.trim().toLowerCase(), { _id: d._id }])),
  };
}

/** Walks parentNodeId up to find the ROOT ancestor — same definition assertRootOrganizationNode enforces (parentNodeId falsy). */
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

interface ResolvedGroupError {
  ok: false;
  error: string;
}
interface ResolvedGroupSuccess {
  ok: true;
  input: CreateExpenditureInput;
  netPayableAmount: number;
}

async function resolveExpenditureGroupOrThrow(group: ParsedGroup, caches: MasterCaches, seenReferences: Set<string>): Promise<ResolvedGroupSuccess> {
  if (seenReferences.has(group.reference)) {
    throw new GroupValidationError(`Duplicate Expenditure Reference "${group.reference}" within this file.`);
  }
  seenReferences.add(group.reference);

  const first = group.rows[0];
  function fail(message: string): never {
    throw new GroupValidationError(`Expenditure Reference "${group.reference}": ${message}`);
  }

  const financialYear = mergeHeaderField(first.financialYear, group.rows, "financialYear");
  const paymentType = mergeHeaderField(first.paymentType, group.rows, "paymentType");
  const billVoucherNumber = mergeHeaderField(first.billVoucherNumber, group.rows, "billVoucherNumber");
  const billVoucherDateRaw = mergeHeaderField(first.billVoucherDate, group.rows, "billVoucherDate");
  const organizationNode = mergeHeaderField(first.organizationNode, group.rows, "organizationNode");
  const beneficiaryType = mergeHeaderField(first.beneficiaryType, group.rows, "beneficiaryType");
  const beneficiaryName = mergeHeaderField(first.beneficiary, group.rows, "beneficiary");
  const beneficiaryIdRaw = mergeHeaderField(first.beneficiaryId, group.rows, "beneficiaryId");
  const scheme = mergeHeaderField(first.scheme, group.rows, "scheme");
  const head = mergeHeaderField(first.head, group.rows, "head");
  const cgstRaw = mergeHeaderField(first.cgstPercent, group.rows, "cgstPercent");
  const igstRaw = mergeHeaderField(first.igstPercent, group.rows, "igstPercent");

  if (!financialYear) fail("Financial Year is required.");
  if (!paymentType || !(EXPENDITURE_PAYMENT_TYPES as readonly string[]).includes(paymentType.toUpperCase())) fail("Payment Type must be ONLINE or CASH.");
  if (!billVoucherNumber) fail("Bill/Voucher Number is required.");
  if (!billVoucherDateRaw) fail("Bill/Voucher Date is required.");
  if (!organizationNode) fail("Organization Node is required.");
  if (!beneficiaryType || !["VENDOR", "EMPLOYEE"].includes(beneficiaryType)) fail("Beneficiary Type must be VENDOR or EMPLOYEE.");
  if (!beneficiaryName && !beneficiaryIdRaw) fail("Beneficiary (name or ID) is required.");
  if (!scheme) fail("Scheme is required.");
  if (!head) fail("Head is required.");

  const financialYearId = caches.financialYearsByLabel.get(financialYear);
  if (!financialYearId) fail(`Unknown Financial Year "${financialYear}".`);

  const orgNode = caches.orgNodesByName.get(organizationNode.trim().toLowerCase());
  if (!orgNode) fail(`Unknown or inactive Organization Node "${organizationNode}".`);
  const organizationRootNodeId = await resolveOrganizationRoot(orgNode._id, caches);

  const schemeRootId = caches.schemeRootsByName.get(scheme.trim().toLowerCase());
  if (!schemeRootId) fail(`Unknown or non-root Scheme "${scheme}".`);

  const headCandidates = caches.headsByNameUnderRoot.get(head.trim().toLowerCase()) ?? [];
  const headMatch = headCandidates.find((h) => String(h._id) === String(schemeRootId) || h.hierarchyPath.includes(`/${schemeRootId}/`));
  if (!headMatch) fail(`Unknown Head "${head}" under Scheme "${scheme}".`);

  const beneficiaryTypeValue = beneficiaryType as BeneficiaryType;
  let beneficiaryId: Types.ObjectId;
  if (beneficiaryIdRaw) {
    const byId = await BeneficiaryModel.findById(beneficiaryIdRaw).select("_id");
    if (!byId) fail(`Beneficiary ID "${beneficiaryIdRaw}" not found.`);
    beneficiaryId = byId._id;
  } else {
    const matches = await BeneficiaryModel.find({
      beneficiaryType: beneficiaryTypeValue,
      name: { $regex: `^${beneficiaryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    }).select("_id");
    if (matches.length === 0) fail(`Beneficiary "${beneficiaryName}" not found.`);
    if (matches.length > 1) fail(`Beneficiary name "${beneficiaryName}" is ambiguous — add a Beneficiary ID column to disambiguate.`);
    beneficiaryId = matches[0]._id;
  }

  const particulars = group.rows.map((row) => ({ description: row.particular, amount: Number(row.amount) }));
  if (particulars.some((p) => !p.description || !Number.isFinite(p.amount) || p.amount <= 0)) {
    fail("every row needs a Particular and a positive Particular Amount.");
  }

  const deductions: Array<{ deductionId: string; amount: number }> = [];
  for (const [name, raw] of first.deductionAmountsByName) {
    if (!raw) continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) fail(`deduction "${name}" has an invalid amount.`);
    const doc = caches.vendorDeductionsByName.get(name.trim().toLowerCase());
    if (!doc) fail(`deduction "${name}" is no longer an Active Vendor deduction.`);
    deductions.push({ deductionId: String(doc._id), amount });
  }

  const cgstPercent = cgstRaw ? Number(cgstRaw) : 0;
  const igstPercent = igstRaw ? Number(igstRaw) : 0;
  if (!(CGST_SGST_SLABS as readonly number[]).includes(cgstPercent)) fail(`CGST % "${cgstRaw}" is not a valid slab (${CGST_SGST_SLABS.join(", ")}).`);
  if (!(IGST_SLABS as readonly number[]).includes(igstPercent)) fail(`IGST % "${igstRaw}" is not a valid slab (${IGST_SLABS.join(", ")}).`);
  if (cgstPercent > 0 && igstPercent > 0) fail("CGST+SGST and IGST cannot both be active.");
  const billVoucherDate = new Date(billVoucherDateRaw);
  if (Number.isNaN(billVoucherDate.getTime())) fail(`Bill/Voucher Date "${billVoucherDateRaw}" is not a valid date.`);

  const grossAmount = particulars.reduce((sum, p) => sum + p.amount, 0);
  const totalWithTax = grossAmount + (grossAmount * cgstPercent) / 100 + (grossAmount * cgstPercent) / 100 + (grossAmount * igstPercent) / 100;
  const totalDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);

  const input: CreateExpenditureInput = {
    financialYearId: String(financialYearId),
    organizationRootNodeId: String(organizationRootNodeId),
    organizationNodeId: String(orgNode._id),
    schemeHeadRootNodeId: String(schemeRootId),
    headId: String(headMatch._id),
    beneficiaryType: beneficiaryTypeValue,
    beneficiaryId: String(beneficiaryId),
    paymentType: paymentType.toUpperCase() as "ONLINE" | "CASH",
    billVoucherNumber,
    billVoucherDate,
    debitNarration: first.debitNarration || undefined,
    creditNarration: first.creditNarration || undefined,
    remarks: first.remarks || undefined,
    enrichment1: first.enrichment1 || undefined,
    enrichment2: first.enrichment2 || undefined,
    particulars,
    cgstPercent,
    sgstPercent: cgstPercent,
    igstPercent,
    deductions,
  };

  return { ok: true, input, netPayableAmount: totalWithTax - totalDeduction };
}

async function resolveExpenditureGroup(group: ParsedGroup, caches: MasterCaches, seenReferences: Set<string>): Promise<ResolvedGroupError | ResolvedGroupSuccess> {
  try {
    return await resolveExpenditureGroupOrThrow(group, caches, seenReferences);
  } catch (error) {
    if (error instanceof GroupValidationError) return { ok: false, error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

export interface ExpenditureBulkUploadRowResult {
  reference: string;
  status: "valid" | "created" | "failed";
  message?: string;
  netPayableAmount?: number;
}

export interface ExpenditureBulkUploadResult {
  dryRun: boolean;
  batchReference: string;
  summary: { totalGroups: number; valid: number; failed: number };
  rows: ExpenditureBulkUploadRowResult[];
}

async function runExpenditureBulkUpload(buffer: Buffer, context: ActorContext, dryRun: boolean, fileName?: string): Promise<ExpenditureBulkUploadResult> {
  const batchReference = crypto.randomUUID();
  const actorId = context.actorId;

  await logActivity({
    user: actorId,
    action: "EXPENDITURE_BULK_UPLOAD_STARTED",
    module: "FINANCE",
    description: `Expenditure bulk upload started${fileName ? ` for "${fileName}"` : ""} (batch ${batchReference}, ${dryRun ? "preview" : "commit"}).`,
    entityType: "Expenditure",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const deductions = await getActiveVendorDeductions();
  const groups = parseExpenditureBulkCsv(buffer, deductions.map((d) => d.name));
  const caches = await buildMasterCaches();
  const seenReferences = new Set<string>();

  const rows: ExpenditureBulkUploadRowResult[] = [];
  let validCount = 0;
  let failedCount = 0;
  let totalAmount = 0;

  for (const group of groups) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveExpenditureGroup(group, caches, seenReferences);
    if (!resolved.ok) {
      failedCount += 1;
      rows.push({ reference: group.reference, status: "failed", message: resolved.error });
      continue;
    }

    if (dryRun) {
      validCount += 1;
      totalAmount += resolved.netPayableAmount;
      rows.push({ reference: group.reference, status: "valid", netPayableAmount: resolved.netPayableAmount });
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const created: ExpenditureDto = await createExpenditure(resolved.input, context);
      validCount += 1;
      totalAmount += created.netPayableAmount;
      rows.push({ reference: group.reference, status: "created", netPayableAmount: created.netPayableAmount });
    } catch (error) {
      failedCount += 1;
      rows.push({ reference: group.reference, status: "failed", message: error instanceof AppError ? error.message : "Failed to create this Expenditure." });
    }
  }

  await logActivity({
    user: actorId,
    action: dryRun ? "EXPENDITURE_BULK_UPLOAD_VALIDATION_COMPLETED" : "EXPENDITURE_BULK_UPLOAD_IMPORTED",
    module: "FINANCE",
    description: `Expenditure bulk upload ${dryRun ? "validated" : "completed"} (batch ${batchReference})${fileName ? ` for "${fileName}"` : ""}: ${validCount} ${dryRun ? "valid" : "created"}, ${failedCount} failed, total ${totalAmount.toFixed(2)}.`,
    entityType: "Expenditure",
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return { dryRun, batchReference, summary: { totalGroups: groups.length, valid: validCount, failed: failedCount }, rows };
}

export async function previewExpenditureBulkUpload(buffer: Buffer, context: ActorContext, fileName?: string): Promise<ExpenditureBulkUploadResult> {
  return runExpenditureBulkUpload(buffer, context, true, fileName);
}

export async function commitExpenditureBulkUpload(buffer: Buffer, context: ActorContext, fileName?: string): Promise<ExpenditureBulkUploadResult> {
  return runExpenditureBulkUpload(buffer, context, false, fileName);
}
