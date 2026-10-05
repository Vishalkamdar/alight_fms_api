import Papa from "papaparse";
import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import {
  BeneficiaryModel,
  type BeneficiaryDocument,
  type BeneficiaryType,
  type BankAccount,
} from "../../models/fms/Beneficiary";
import { OrganizationNodeModel } from "../../models/OrganizationNode";
import { INDIAN_STATES_AND_UTS } from "../../constants/indianStates";
import type { UserRole } from "../../models/User";
import { GLOBAL_DEPARTMENT_SENTINEL } from "../../schemas/fms/beneficiary.schema";
import type {
  BankAccountInput,
  BeneficiaryExportQuery,
  BeneficiaryListQuery,
  CreateBeneficiaryInput,
  UpdateBeneficiaryInput,
} from "../../schemas/fms/beneficiary.schema";

interface ActorContext {
  actorId: Types.ObjectId | null;
  actorRole?: UserRole;
  /**
   * null = unrestricted (Super Admin/Admin); a string[] = the caller is an
   * FMS Operational User - Maker and may only read/write Global
   * (organizationNodeId: null) beneficiaries plus beneficiaries belonging
   * to one of these node ids — their own assigned department(s) and any
   * descendant node they govern (see getAllowedNodeIdsForList, the exact
   * mechanism already used for Budget Allocation). Computed in the
   * controller and passed straight through, never re-derived here.
   */
  allowedNodeIds?: string[] | null;
  ipAddress: string | null;
  userAgent?: string | null;
}

/**
 * Resolves the client-facing organizationNodeId field — "GLOBAL", a
 * specific Organization Node id, or omitted — into what actually gets
 * stored, while enforcing who's allowed to use it. This is the real
 * authorization boundary for the Department feature, not the frontend's
 * Department Select (which only ever offers a Maker their own
 * department(s) and never shows Global to them) — a crafted request must
 * not be able to go around it.
 *
 * - Super Admin/Admin (allowedNodeIds === null): unrestricted — any
 *   existing node, or Global (omitted / "GLOBAL").
 * - Maker (allowedNodeIds is their own node list): never Global, never
 *   another department's node; omitted defaults to their one department
 *   when they only have one, otherwise they must pick.
 */
async function resolveDepartmentNode(
  requested: string | undefined,
  allowedNodeIds: string[] | null
): Promise<Types.ObjectId | null> {
  if (allowedNodeIds === null) {
    if (!requested || requested === GLOBAL_DEPARTMENT_SENTINEL) return null;
    const exists = await OrganizationNodeModel.exists({ _id: requested });
    if (!exists) throw new AppError(404, "Selected Department not found.", { organizationNodeId: ["Not found."] });
    return new Types.ObjectId(requested);
  }

  if (!requested) {
    if (allowedNodeIds.length === 1) return new Types.ObjectId(allowedNodeIds[0]);
    throw new AppError(422, "Select a Department.", { organizationNodeId: ["Required."] });
  }
  if (requested === GLOBAL_DEPARTMENT_SENTINEL) {
    throw new AppError(403, "Only Super Admin or Admin may mark a beneficiary as Global.", {
      organizationNodeId: ["Global is restricted to Super Admin/Admin."],
    });
  }
  if (!allowedNodeIds.includes(requested)) {
    throw new AppError(403, "You may only assign your own Department.", {
      organizationNodeId: ["Outside your assigned Department."],
    });
  }
  return new Types.ObjectId(requested);
}

/**
 * Confirms the actor may act on this specific beneficiary — unrestricted
 * for Super Admin/Admin. For a Maker, a Global record is visible but
 * read-only (only Super Admin/Admin may edit/deactivate/delete a Global
 * beneficiary), and any other department's record doesn't exist as far as
 * they're concerned — 404, not 403, so its existence isn't leaked (matches
 * the pattern used for Budget Allocation's node scoping).
 */
function assertWithinScope(doc: BeneficiaryDocument, allowedNodeIds: string[] | null | undefined, mode: "read" | "write"): void {
  if (allowedNodeIds === null || allowedNodeIds === undefined) return;
  if (doc.organizationNodeId === null) {
    if (mode === "write") {
      throw new AppError(403, "Global beneficiaries can only be edited by Super Admin or Admin.");
    }
    return;
  }
  if (!allowedNodeIds.includes(String(doc.organizationNodeId))) {
    throw new AppError(404, "Beneficiary not found.");
  }
}

function requireActorId(context: ActorContext): Types.ObjectId {
  if (!context.actorId) throw new AppError(401, "Authentication required.");
  return context.actorId;
}

export interface BankAccountDto {
  _id: string;
  bankName: string;
  branchName: string;
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  accountType: string | null;
  isDefault: boolean;
}

export interface BeneficiaryDto {
  _id: string;
  beneficiaryType: BeneficiaryType;
  organizationNodeId: string | null;
  organizationNode: { _id: string; name: string } | null;
  name: string;
  contactPersonName: string | null;
  gstNumber: string | null;
  employeeId: string | null;
  email: string | null;
  mobile: string;
  phone: string | null;
  address: string | null;
  area: string | null;
  state: string | null;
  district: string | null;
  city: string | null;
  pincode: string | null;
  panNumber: string | null;
  isActive: boolean;
  paymentMode: "BANK" | "CASH";
  bankAccounts: BankAccountDto[];
  defaultBankAccount: BankAccountDto | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

function serializeBankAccount(bank: BankAccount): BankAccountDto {
  return {
    _id: String(bank._id),
    bankName: bank.bankName,
    branchName: bank.branchName,
    accountNumber: bank.accountNumber,
    ifscCode: bank.ifscCode,
    accountHolderName: bank.accountHolderName,
    accountType: bank.accountType,
    isDefault: bank.isDefault,
  };
}

function serialize(doc: BeneficiaryDocument, organizationNodeName?: string | null): BeneficiaryDto {
  const bankAccounts = doc.bankAccounts.map(serializeBankAccount);
  return {
    _id: String(doc._id),
    beneficiaryType: doc.beneficiaryType,
    organizationNodeId: doc.organizationNodeId ? String(doc.organizationNodeId) : null,
    organizationNode:
      doc.organizationNodeId && organizationNodeName
        ? { _id: String(doc.organizationNodeId), name: organizationNodeName }
        : null,
    name: doc.name,
    contactPersonName: doc.contactPersonName,
    gstNumber: doc.gstNumber,
    employeeId: doc.employeeId,
    email: doc.email,
    mobile: doc.mobile,
    phone: doc.phone,
    address: doc.address,
    area: doc.area,
    state: doc.state,
    district: doc.district,
    city: doc.city,
    pincode: doc.pincode,
    panNumber: doc.panNumber,
    isActive: doc.isActive,
    paymentMode: doc.paymentMode,
    bankAccounts,
    defaultBankAccount: bankAccounts.find((b) => b.isDefault) ?? null,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Looks up a single node's name for serialize() after a create/update/get. */
async function serializeWithNode(doc: BeneficiaryDocument): Promise<BeneficiaryDto> {
  if (!doc.organizationNodeId) return serialize(doc, null);
  const node = await OrganizationNodeModel.findById(doc.organizationNodeId).select("name").lean();
  return serialize(doc, node?.name ?? null);
}

/** Batched name lookup for a page of list/export results — one query, not N. */
async function buildNodeNameMap(nodeIds: Array<Types.ObjectId | null>): Promise<Map<string, string>> {
  const ids = [...new Set(nodeIds.filter((id): id is Types.ObjectId => id !== null).map((id) => String(id)))];
  if (ids.length === 0) return new Map();
  const nodes = await OrganizationNodeModel.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(nodes.map((n) => [String(n._id), n.name]));
}

/**
 * Re-checks, server-side, exactly the rules the schema's superRefine
 * already enforces on well-formed input — a crafted request that skips the
 * Zod layer (or a bulk-import row, which doesn't go through it at all)
 * must still never be able to create an Employee without PAN/Employee ID
 * or a Vendor without a Contact Person, and must never end up with zero
 * or multiple default bank accounts while on BANK payment mode (§18).
 * GST is intentionally not required for Vendor — plenty of real vendors
 * legitimately have none (unregistered, below threshold, individuals); a
 * GST value is still format-validated when one IS provided, just never
 * mandatory to have.
 */
function assertTypeRulesAndNormalize(input: {
  beneficiaryType: BeneficiaryType;
  contactPersonName?: string | null;
  gstNumber?: string | null;
  employeeId?: string | null;
  panNumber?: string | null;
  paymentMode: "BANK" | "CASH";
  bankAccounts: Array<{ isDefault?: boolean }>;
}): void {
  if (input.beneficiaryType === "VENDOR") {
    if (!input.contactPersonName) throw new AppError(422, "Contact Person Name is required for a Vendor.", { contactPersonName: ["Required for Vendor."] });
  } else {
    if (!input.employeeId) throw new AppError(422, "Employee ID is required for an Employee.", { employeeId: ["Required for Employee."] });
    if (!input.panNumber) throw new AppError(422, "PAN Number is required for an Employee.", { panNumber: ["Required for Employee."] });
    if (input.gstNumber) throw new AppError(422, "GST Number is not applicable for an Employee.", { gstNumber: ["Not applicable for Employee."] });
  }

  if (input.paymentMode === "BANK") {
    if (input.bankAccounts.length === 0) {
      throw new AppError(422, "At least one bank account is required when not paying by cash.", { bankAccounts: ["Add at least one bank account."] });
    }
    const defaultCount = input.bankAccounts.filter((b) => b.isDefault).length;
    if (defaultCount === 0) {
      throw new AppError(422, "Mark exactly one bank account as Default.", { bankAccounts: ["No default bank account specified."] });
    }
    if (defaultCount > 1) {
      throw new AppError(422, "Only one bank account may be marked as Default.", { bankAccounts: ["More than one default bank account."] });
    }
  }
}

interface DuplicateCheckInput {
  beneficiaryType: BeneficiaryType;
  gstNumber?: string | null;
  panNumber?: string | null;
  employeeId?: string | null;
  name: string;
}

/** Vendor: GST/PAN/name. Employee: Employee ID/PAN. Never silently creates a duplicate — §12. */
async function assertNoDuplicate(input: DuplicateCheckInput, excludeId?: string): Promise<void> {
  const orConditions: Record<string, unknown>[] = [];
  if (input.beneficiaryType === "VENDOR") {
    if (input.gstNumber) orConditions.push({ gstNumber: input.gstNumber });
    if (input.panNumber) orConditions.push({ panNumber: input.panNumber });
    orConditions.push({ name: { $regex: `^${escapeRegex(input.name)}$`, $options: "i" } });
  } else {
    if (input.employeeId) orConditions.push({ employeeId: input.employeeId });
    if (input.panNumber) orConditions.push({ panNumber: input.panNumber });
  }
  if (orConditions.length === 0) return;

  const match: Record<string, unknown> = { beneficiaryType: input.beneficiaryType, $or: orConditions };
  if (excludeId) match._id = { $ne: excludeId };

  const existing = await BeneficiaryModel.findOne(match).select("name gstNumber panNumber employeeId");
  if (existing) {
    const field =
      input.beneficiaryType === "VENDOR"
        ? existing.gstNumber && existing.gstNumber === input.gstNumber
          ? "GST Number"
          : existing.panNumber && existing.panNumber === input.panNumber
            ? "PAN Number"
            : "Vendor Name"
        : existing.employeeId && existing.employeeId === input.employeeId
          ? "Employee ID"
          : "PAN Number";
    throw new AppError(409, `A ${input.beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} with this ${field} already exists ("${existing.name}").`, {
      duplicate: [`Matches existing record: ${existing.name}`],
    });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOptional(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toBankAccountDocs(rows: BankAccountInput[]): BankAccount[] {
  return rows.map((row) => ({
    _id: new Types.ObjectId(),
    bankName: row.bankName.trim(),
    branchName: row.branchName.trim(),
    accountNumber: row.accountNumber.trim(),
    ifscCode: row.ifscCode.trim().toUpperCase(),
    accountHolderName: (row.accountHolderName ?? "").trim(),
    accountType: row.accountType ?? null,
    isDefault: Boolean(row.isDefault),
  })) as BankAccount[];
}

export async function createBeneficiary(input: CreateBeneficiaryInput, context: ActorContext): Promise<BeneficiaryDto> {
  const actorId = requireActorId(context);
  const organizationNodeId = await resolveDepartmentNode(input.organizationNodeId, context.allowedNodeIds ?? null);

  // Validate against what was actually SENT first — nulling out a
  // not-applicable GST before checking would make the "GST is not
  // applicable for an Employee" rule dead code, letting a crafted request
  // silently slip an Employee+GST combination through unrejected (§18).
  const normalized = {
    beneficiaryType: input.beneficiaryType,
    contactPersonName: normalizeOptional(input.contactPersonName),
    gstNumber: normalizeOptional(input.gstNumber),
    employeeId: normalizeOptional(input.employeeId),
    panNumber: normalizeOptional(input.panNumber),
    paymentMode: input.paymentMode ?? "BANK",
    bankAccounts: input.paymentMode === "CASH" ? [] : input.bankAccounts,
  };
  assertTypeRulesAndNormalize(normalized);
  // Only now safe to drop — validation above already confirmed it was never
  // provided for an Employee in the first place.
  if (input.beneficiaryType === "EMPLOYEE") normalized.gstNumber = null;

  await assertNoDuplicate({
    beneficiaryType: input.beneficiaryType,
    gstNumber: normalized.gstNumber,
    panNumber: normalized.panNumber,
    employeeId: normalized.employeeId,
    name: input.name,
  });

  const doc = await BeneficiaryModel.create({
    beneficiaryType: input.beneficiaryType,
    organizationNodeId,
    name: input.name.trim(),
    contactPersonName: normalized.contactPersonName,
    gstNumber: normalized.gstNumber,
    employeeId: normalized.employeeId,
    email: normalizeOptional(input.email),
    mobile: input.mobile.trim(),
    phone: normalizeOptional(input.phone),
    address: normalizeOptional(input.address),
    area: normalizeOptional(input.area),
    state: input.state,
    district: normalizeOptional(input.district),
    city: normalizeOptional(input.city),
    pincode: normalizeOptional(input.pincode),
    panNumber: normalized.panNumber,
    isActive: input.isActive ?? true,
    paymentMode: normalized.paymentMode,
    bankAccounts: toBankAccountDocs(normalized.bankAccounts),
    createdBy: actorId,
    updatedBy: actorId,
  });

  await logActivity({
    user: actorId,
    action: "BENEFICIARY_CREATED",
    module: "MASTER_DATA",
    description: `Created ${input.beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} beneficiary "${doc.name}".`,
    entityType: "Beneficiary",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serializeWithNode(doc);
}

async function findByIdOr404(
  id: string,
  allowedNodeIds: string[] | null | undefined,
  mode: "read" | "write"
): Promise<BeneficiaryDocument> {
  const doc = await BeneficiaryModel.findById(id);
  if (!doc) throw new AppError(404, "Beneficiary not found.");
  assertWithinScope(doc, allowedNodeIds, mode);
  return doc;
}

export async function getBeneficiaryById(id: string, allowedNodeIds: string[] | null): Promise<BeneficiaryDto> {
  const doc = await findByIdOr404(id, allowedNodeIds, "read");
  return serializeWithNode(doc);
}

export async function updateBeneficiary(id: string, input: UpdateBeneficiaryInput, context: ActorContext): Promise<BeneficiaryDto> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id, context.allowedNodeIds, "write");
  const organizationNodeId = await resolveDepartmentNode(input.organizationNodeId, context.allowedNodeIds ?? null);

  const normalized = {
    beneficiaryType: input.beneficiaryType,
    contactPersonName: normalizeOptional(input.contactPersonName),
    gstNumber: normalizeOptional(input.gstNumber),
    employeeId: normalizeOptional(input.employeeId),
    panNumber: normalizeOptional(input.panNumber),
    paymentMode: input.paymentMode ?? "BANK",
    bankAccounts: input.paymentMode === "CASH" ? [] : input.bankAccounts,
  };
  assertTypeRulesAndNormalize(normalized);
  if (input.beneficiaryType === "EMPLOYEE") normalized.gstNumber = null;

  await assertNoDuplicate(
    {
      beneficiaryType: input.beneficiaryType,
      gstNumber: normalized.gstNumber,
      panNumber: normalized.panNumber,
      employeeId: normalized.employeeId,
      name: input.name,
    },
    id
  );

  doc.beneficiaryType = input.beneficiaryType;
  doc.organizationNodeId = organizationNodeId;
  doc.name = input.name.trim();
  doc.contactPersonName = normalized.contactPersonName;
  doc.gstNumber = normalized.gstNumber;
  doc.employeeId = normalized.employeeId;
  doc.email = normalizeOptional(input.email);
  doc.mobile = input.mobile.trim();
  doc.phone = normalizeOptional(input.phone);
  doc.address = normalizeOptional(input.address);
  doc.area = normalizeOptional(input.area);
  doc.state = input.state;
  doc.district = normalizeOptional(input.district);
  doc.city = normalizeOptional(input.city);
  doc.pincode = normalizeOptional(input.pincode);
  doc.panNumber = normalized.panNumber;
  doc.isActive = input.isActive ?? true;
  doc.paymentMode = normalized.paymentMode;
  doc.bankAccounts.splice(0, doc.bankAccounts.length, ...toBankAccountDocs(normalized.bankAccounts));
  doc.updatedBy = actorId;
  await doc.save();

  await logActivity({
    user: actorId,
    action: "BENEFICIARY_UPDATED",
    module: "MASTER_DATA",
    description: `Updated ${doc.beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} beneficiary "${doc.name}".`,
    entityType: "Beneficiary",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serializeWithNode(doc);
}

export async function setBeneficiaryActive(id: string, isActive: boolean, context: ActorContext): Promise<BeneficiaryDto> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id, context.allowedNodeIds, "write");
  doc.isActive = isActive;
  doc.updatedBy = actorId;
  await doc.save();

  await logActivity({
    user: actorId,
    action: isActive ? "BENEFICIARY_ACTIVATED" : "BENEFICIARY_DEACTIVATED",
    module: "MASTER_DATA",
    description: `${isActive ? "Activated" : "Deactivated"} beneficiary "${doc.name}".`,
    entityType: "Beneficiary",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serializeWithNode(doc);
}

export async function deleteBeneficiary(id: string, context: ActorContext): Promise<void> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id, context.allowedNodeIds, "write");
  await BeneficiaryModel.deleteOne({ _id: doc._id });

  await logActivity({
    user: actorId,
    action: "BENEFICIARY_DELETED",
    module: "MASTER_DATA",
    description: `Deleted ${doc.beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} beneficiary "${doc.name}".`,
    entityType: "Beneficiary",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

/**
 * Department scoping (§ Department feature) and free-text search both need
 * their own $or, so they're combined under $and rather than one clobbering
 * the other on the same `match` object.
 */
function buildListMatch(query: BeneficiaryListQuery | BeneficiaryExportQuery, allowedNodeIds?: string[] | null): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (query.beneficiaryType) match.beneficiaryType = query.beneficiaryType;
  if (query.employeeId) match.employeeId = { $regex: escapeRegex(query.employeeId), $options: "i" };
  if (query.panNumber) match.panNumber = { $regex: escapeRegex(query.panNumber), $options: "i" };
  if (query.gstNumber) match.gstNumber = { $regex: escapeRegex(query.gstNumber), $options: "i" };
  if (query.state) match.state = query.state;
  if (query.city) match.city = { $regex: escapeRegex(query.city), $options: "i" };
  if (query.isActive !== undefined) match.isActive = query.isActive;
  if (query.dateFrom || query.dateTo) {
    const createdAt: Record<string, Date> = {};
    if (query.dateFrom) createdAt.$gte = query.dateFrom;
    if (query.dateTo) createdAt.$lte = query.dateTo;
    match.createdAt = createdAt;
  }

  const andConditions: Record<string, unknown>[] = [];

  if (query.organizationNodeId) {
    if (query.organizationNodeId === GLOBAL_DEPARTMENT_SENTINEL) {
      match.organizationNodeId = null;
    } else {
      if (allowedNodeIds && !allowedNodeIds.includes(query.organizationNodeId)) {
        throw new AppError(403, "You may only filter by your own Department.");
      }
      match.organizationNodeId = new Types.ObjectId(query.organizationNodeId);
    }
  } else if (allowedNodeIds) {
    andConditions.push({
      $or: [{ organizationNodeId: null }, { organizationNodeId: { $in: allowedNodeIds.map((id) => new Types.ObjectId(id)) } }],
    });
  }

  if (query.search) {
    const regex = { $regex: escapeRegex(query.search), $options: "i" };
    andConditions.push({ $or: [{ name: regex }, { employeeId: regex }, { panNumber: regex }, { gstNumber: regex }, { mobile: regex }] });
  }

  if (andConditions.length > 0) match.$and = andConditions;
  return match;
}

export async function listBeneficiaries(query: BeneficiaryListQuery, allowedNodeIds: string[] | null): Promise<ListResult<BeneficiaryDto>> {
  const match = buildListMatch(query, allowedNodeIds);
  const sortField = query.sortBy;
  const [docs, total] = await Promise.all([
    BeneficiaryModel.find(match)
      .sort({ [sortField]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    BeneficiaryModel.countDocuments(match),
  ]);

  const nameMap = await buildNodeNameMap(docs.map((d) => d.organizationNodeId));
  return {
    items: docs.map((doc) => serialize(doc, doc.organizationNodeId ? nameMap.get(String(doc.organizationNodeId)) ?? null : null)),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getBeneficiariesCursorForExport(query: BeneficiaryExportQuery, allowedNodeIds: string[] | null) {
  const match = buildListMatch(query, allowedNodeIds);
  return BeneficiaryModel.find(match)
    .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
    .cursor();
}

// ---------------------------------------------------------------------------
// Bulk import — same dry-run/commit, per-row-result shape as the existing
// Organization Node bulk import, mirrored for consistency with the one
// bulk-import pattern already established in this codebase.
// ---------------------------------------------------------------------------

export interface BeneficiaryBulkImportRowResult {
  row: number;
  name: string;
  status: "created" | "skipped" | "failed";
  message?: string;
}

export interface BeneficiaryBulkImportResult {
  dryRun: boolean;
  summary: { total: number; created: number; skipped: number; failed: number };
  rows: BeneficiaryBulkImportRowResult[];
}

const MAX_BULK_ROWS = 1000;
const MAX_BANK_ACCOUNTS_PER_ROW = 5;

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

interface ParsedBulkRow {
  row: number;
  name: string;
  department: string;
  contactPersonOrEmployeeId: string;
  email: string;
  mobile: string;
  phone: string;
  address: string;
  area: string;
  state: string;
  district: string;
  city: string;
  pincode: string;
  pan: string;
  gst: string;
  isActive: boolean;
  bankAccounts: Array<{ bankName: string; accountNumber: string; ifscCode: string; branchName: string; isDefault: boolean }>;
}

function parseBulkCsv(buffer: Buffer, beneficiaryType: BeneficiaryType): ParsedBulkRow[] {
  const text = buffer.toString("utf-8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new AppError(422, `Could not parse the CSV file: ${parsed.errors[0].message}`);
  }
  const rawHeaders = parsed.meta.fields ?? [];
  if (rawHeaders.length === 0) throw new AppError(422, "The CSV file has no header row.");
  if (parsed.data.length === 0) throw new AppError(422, "The CSV file has no data rows.");
  if (parsed.data.length > MAX_BULK_ROWS) throw new AppError(422, `A single import is limited to ${MAX_BULK_ROWS} rows.`);

  const headerMap = new Map(rawHeaders.map((h) => [normalizeHeader(h), h]));
  const nameCol = findColumn(headerMap, beneficiaryType === "VENDOR" ? ["vendorname", "name"] : ["employeename", "name"]);
  const departmentCol = findColumn(headerMap, ["department", "dept", "organizationnode", "org"]);
  const idCol = findColumn(headerMap, beneficiaryType === "VENDOR" ? ["contactperson", "contactpersonname"] : ["employeeid"]);
  const emailCol = findColumn(headerMap, ["email", "emailid"]);
  const mobileCol = findColumn(headerMap, ["mobile", "mobileno"]);
  const phoneCol = findColumn(headerMap, ["phone", "phoneno"]);
  const addressCol = findColumn(headerMap, ["address"]);
  const areaCol = findColumn(headerMap, ["area"]);
  const stateCol = findColumn(headerMap, ["state"]);
  const districtCol = findColumn(headerMap, ["district"]);
  const cityCol = findColumn(headerMap, ["city"]);
  const pincodeCol = findColumn(headerMap, ["pincode", "pin"]);
  const panCol = findColumn(headerMap, ["pan", "panno"]);
  const gstCol = findColumn(headerMap, ["gst", "gstno"]);
  const activeCol = findColumn(headerMap, ["active", "isactive", "status"]);

  if (!nameCol) {
    throw new AppError(422, `The CSV must include a "${beneficiaryType === "VENDOR" ? "Vendor Name" : "Employee Name"}" column.`);
  }

  return parsed.data.map((record, index) => {
    const bankAccounts: ParsedBulkRow["bankAccounts"] = [];
    for (let n = 1; n <= MAX_BANK_ACCOUNTS_PER_ROW; n += 1) {
      const bankNameCol = findColumn(headerMap, [`bank${n}name`]);
      if (!bankNameCol) break;
      const bankName = (record[bankNameCol] ?? "").trim();
      if (!bankName) continue;
      const acctCol = findColumn(headerMap, [`bank${n}accountno`, `bank${n}accountnumber`]);
      const ifscCol = findColumn(headerMap, [`bank${n}ifsc`, `bank${n}ifsccode`]);
      const branchCol = findColumn(headerMap, [`bank${n}branch`, `bank${n}branchname`]);
      const defaultCol = findColumn(headerMap, [`bank${n}default`]);
      bankAccounts.push({
        bankName,
        accountNumber: (acctCol ? record[acctCol] : "")?.trim() ?? "",
        ifscCode: (ifscCol ? record[ifscCol] : "")?.trim().toUpperCase() ?? "",
        branchName: (branchCol ? record[branchCol] : "")?.trim() ?? "",
        isDefault: /^(y|yes|true|1)$/i.test((defaultCol ? record[defaultCol] : "")?.trim() ?? ""),
      });
    }

    const activeRaw = (activeCol ? record[activeCol] : "")?.trim() ?? "";
    const isActive = activeRaw === "" ? true : /^(y|yes|true|1|active)$/i.test(activeRaw);

    return {
      row: index + 2,
      name: (record[nameCol] ?? "").trim(),
      department: (departmentCol ? record[departmentCol] : "")?.trim() ?? "",
      contactPersonOrEmployeeId: (idCol ? record[idCol] : "")?.trim() ?? "",
      email: (emailCol ? record[emailCol] : "")?.trim() ?? "",
      mobile: (mobileCol ? record[mobileCol] : "")?.trim() ?? "",
      phone: (phoneCol ? record[phoneCol] : "")?.trim() ?? "",
      address: (addressCol ? record[addressCol] : "")?.trim() ?? "",
      area: (areaCol ? record[areaCol] : "")?.trim() ?? "",
      state: (stateCol ? record[stateCol] : "")?.trim() ?? "",
      district: (districtCol ? record[districtCol] : "")?.trim() ?? "",
      city: (cityCol ? record[cityCol] : "")?.trim() ?? "",
      pincode: (pincodeCol ? record[pincodeCol] : "")?.trim() ?? "",
      pan: (panCol ? record[panCol] : "")?.trim().toUpperCase() ?? "",
      gst: (gstCol ? record[gstCol] : "")?.trim().toUpperCase() ?? "",
      isActive,
      bankAccounts,
    };
  });
}

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MOBILE_REGEX = /^[6-9]\d{9}$/;

export async function bulkImportBeneficiaries(
  beneficiaryType: BeneficiaryType,
  csvBuffer: Buffer,
  actorId: Types.ObjectId,
  allowedNodeIds: string[] | null,
  context: { ipAddress: string | null; userAgent?: string | null; fileName?: string },
  dryRun: boolean
): Promise<BeneficiaryBulkImportResult> {
  const rows = parseBulkCsv(csvBuffer, beneficiaryType);

  const [existingGstOrPan, existingEmployeeIds, activeNodes] = await Promise.all([
    BeneficiaryModel.find({ beneficiaryType }).select("name gstNumber panNumber").lean(),
    BeneficiaryModel.find({ beneficiaryType: "EMPLOYEE" }).select("employeeId").lean(),
    OrganizationNodeModel.find({ status: "Active" }).select("name").lean(),
  ]);
  const existingGstSet = new Set(existingGstOrPan.map((d) => d.gstNumber).filter(Boolean));
  const existingPanSet = new Set(existingGstOrPan.map((d) => d.panNumber).filter(Boolean));
  const existingEmployeeIdSet = new Set(existingEmployeeIds.map((d) => d.employeeId).filter(Boolean));
  const importedGstSet = new Set<string>();
  const importedPanSet = new Set<string>();
  const importedEmployeeIdSet = new Set<string>();

  const nodeIdByName = new Map(activeNodes.map((n) => [n.name.trim().toLowerCase(), String(n._id)]));
  const nodeNameById = new Map(activeNodes.map((n) => [String(n._id), n.name]));

  /**
   * CSV rows carry a Department NAME (there's no sane way to ask a user to
   * type an ObjectId), resolved against the active Organization Node tree —
   * a separate lookup domain from resolveDepartmentNode's id/"GLOBAL"
   * sentinel used by the JSON create/update endpoints. Same authorization
   * boundary though: a Maker's row can never land on Global or another
   * department, no matter what the CSV says.
   */
  function resolveDepartmentForRow(rawDept: string): { ok: true; nodeId: Types.ObjectId | null } | { ok: false; message: string } {
    const trimmed = rawDept.trim();
    if (!trimmed || /^global$/i.test(trimmed)) {
      if (allowedNodeIds === null) return { ok: true, nodeId: null };
      if (allowedNodeIds.length === 1) return { ok: true, nodeId: new Types.ObjectId(allowedNodeIds[0]) };
      return {
        ok: false,
        message: `Specify a Department — you belong to multiple (${allowedNodeIds.map((id) => nodeNameById.get(id) ?? id).join(", ")}).`,
      };
    }
    const matchedId = nodeIdByName.get(trimmed.toLowerCase());
    if (!matchedId) return { ok: false, message: `Unknown Department "${trimmed}".` };
    if (allowedNodeIds !== null && !allowedNodeIds.includes(matchedId)) {
      return { ok: false, message: `You may only import into your own Department ("${trimmed}" is not one of yours).` };
    }
    return { ok: true, nodeId: new Types.ObjectId(matchedId) };
  }

  const results: BeneficiaryBulkImportRowResult[] = [];

  for (const row of rows) {
    const fail = (message: string) => results.push({ row: row.row, name: row.name, status: "failed", message });

    if (!row.name) {
      fail(`${beneficiaryType === "VENDOR" ? "Vendor Name" : "Employee Name"} is required.`);
      continue;
    }
    if (!MOBILE_REGEX.test(row.mobile)) {
      fail("A valid 10-digit Mobile No. is required.");
      continue;
    }
    if (!row.state || !INDIAN_STATES_AND_UTS.includes(row.state as never)) {
      fail("Invalid State.");
      continue;
    }

    if (beneficiaryType === "VENDOR") {
      if (!row.contactPersonOrEmployeeId) {
        fail("Contact Person is required for Vendor.");
        continue;
      }
      // GST is optional for Vendor — plenty of real vendors legitimately
      // have none — but a provided value still has to be validly formatted.
      if (row.gst && !GST_REGEX.test(row.gst)) {
        fail("Invalid GST format.");
        continue;
      }
      if (row.pan && !PAN_REGEX.test(row.pan)) {
        fail("Invalid PAN format.");
        continue;
      }
      if (row.gst && (existingGstSet.has(row.gst) || importedGstSet.has(row.gst))) {
        fail(`Duplicate — a Vendor with GST ${row.gst} already exists.`);
        continue;
      }
      if (row.pan && (existingPanSet.has(row.pan) || importedPanSet.has(row.pan))) {
        fail(`Duplicate — a Vendor with PAN ${row.pan} already exists.`);
        continue;
      }
    } else {
      if (!row.contactPersonOrEmployeeId) {
        fail("Employee ID is required for Employee.");
        continue;
      }
      if (!PAN_REGEX.test(row.pan)) {
        fail("A valid PAN Number is required for Employee.");
        continue;
      }
      if (existingEmployeeIdSet.has(row.contactPersonOrEmployeeId) || importedEmployeeIdSet.has(row.contactPersonOrEmployeeId)) {
        fail(`Duplicate — an Employee with ID ${row.contactPersonOrEmployeeId} already exists.`);
        continue;
      }
      if (existingPanSet.has(row.pan) || importedPanSet.has(row.pan)) {
        fail(`Duplicate — an Employee with PAN ${row.pan} already exists.`);
        continue;
      }
    }

    let bankAccounts = row.bankAccounts;
    if (bankAccounts.length > 0) {
      const invalidBank = bankAccounts.find((b) => !b.accountNumber || !IFSC_REGEX.test(b.ifscCode) || !b.branchName);
      if (invalidBank) {
        fail(`Invalid bank account details for "${invalidBank.bankName}" (check A/C Number, IFSC, Branch).`);
        continue;
      }
      const defaultCount = bankAccounts.filter((b) => b.isDefault).length;
      if (defaultCount === 0) {
        // No explicit default marked — the first bank account becomes default rather than failing the row outright.
        bankAccounts = bankAccounts.map((b, i) => ({ ...b, isDefault: i === 0 }));
      } else if (defaultCount > 1) {
        fail("More than one bank account marked as Default — only one is allowed.");
        continue;
      }
    }

    const departmentResult = resolveDepartmentForRow(row.department);
    if (!departmentResult.ok) {
      fail(departmentResult.message);
      continue;
    }

    if (!dryRun) {
      const doc = await BeneficiaryModel.create({
        beneficiaryType,
        organizationNodeId: departmentResult.nodeId,
        name: row.name,
        contactPersonName: beneficiaryType === "VENDOR" ? row.contactPersonOrEmployeeId : null,
        employeeId: beneficiaryType === "EMPLOYEE" ? row.contactPersonOrEmployeeId : null,
        gstNumber: beneficiaryType === "VENDOR" && row.gst ? row.gst : null,
        email: row.email || null,
        mobile: row.mobile,
        phone: row.phone || null,
        address: row.address || null,
        area: row.area || null,
        state: row.state,
        district: row.district || null,
        city: row.city || null,
        pincode: row.pincode || null,
        panNumber: row.pan || null,
        isActive: row.isActive,
        paymentMode: bankAccounts.length > 0 ? "BANK" : "CASH",
        bankAccounts: bankAccounts.map((b) => ({
          _id: new Types.ObjectId(),
          bankName: b.bankName,
          branchName: b.branchName,
          accountNumber: b.accountNumber,
          ifscCode: b.ifscCode,
          accountHolderName: "",
          accountType: null,
          isDefault: b.isDefault,
        })),
        createdBy: actorId,
        updatedBy: actorId,
      });
      results.push({ row: row.row, name: doc.name, status: "created" });
    } else {
      results.push({ row: row.row, name: row.name, status: "created" });
    }

    if (beneficiaryType === "VENDOR") {
      if (row.gst) importedGstSet.add(row.gst);
      if (row.pan) importedPanSet.add(row.pan);
    } else {
      importedEmployeeIdSet.add(row.contactPersonOrEmployeeId);
      importedPanSet.add(row.pan);
    }
  }

  const orderedResults = rows.map((row) => results.find((r) => r.row === row.row)!);
  const summary = orderedResults.reduce(
    (acc, result) => {
      acc[result.status] += 1;
      return acc;
    },
    { created: 0, skipped: 0, failed: 0 }
  );

  if (!dryRun && summary.created > 0) {
    await logActivity({
      user: actorId,
      action: "BENEFICIARY_BULK_IMPORTED",
      module: "MASTER_DATA",
      description: `Bulk imported ${summary.created} ${beneficiaryType === "VENDOR" ? "Vendor" : "Employee"} beneficiar${summary.created === 1 ? "y" : "ies"}${
        context.fileName ? ` from "${context.fileName}"` : ""
      } (${summary.failed} failed).`,
      entityType: "Beneficiary",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  return { dryRun, summary: { total: rows.length, ...summary }, rows: orderedResults };
}
