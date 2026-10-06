import { Types } from "mongoose";
import { AppError } from "../../utils/AppError";
import { logActivity } from "../../utils/activity-log";
import {
  DeductionMasterModel,
  type DeductionMasterDocument,
  type DeductionType,
  type DeductionCalculationType,
} from "../../models/fms/DeductionMaster";
import type {
  CreateDeductionMasterInput,
  DeductionMasterExportQuery,
  DeductionMasterListQuery,
  UpdateDeductionMasterInput,
} from "../../schemas/fms/deduction-master.schema";

interface ActorContext {
  actorId: Types.ObjectId | null;
  ipAddress: string | null;
  userAgent?: string | null;
}

function requireActorId(context: ActorContext): Types.ObjectId {
  if (!context.actorId) throw new AppError(401, "Authentication required.");
  return context.actorId;
}

export interface DeductionMasterDto {
  _id: string;
  name: string;
  deductionType: DeductionType;
  calculationType: DeductionCalculationType;
  defaultPercentage: number | null;
  defaultAmount: number | null;
  isActive: boolean;
  displayOrder: number;
  remarks: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListResult<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

function serialize(doc: DeductionMasterDocument): DeductionMasterDto {
  return {
    _id: String(doc._id),
    name: doc.name,
    deductionType: doc.deductionType,
    calculationType: doc.calculationType,
    defaultPercentage: doc.defaultPercentage,
    defaultAmount: doc.defaultAmount,
    isActive: doc.isActive,
    displayOrder: doc.displayOrder,
    remarks: doc.remarks,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The field that's irrelevant to the chosen calculation type is always
 * cleared rather than validated-and-rejected — "Do not force a percentage
 * for Fixed Amount deductions" (§11). A value submitted for the wrong field
 * is simply dropped, never stored, so it can't leak into a later snapshot.
 */
function normalizeCalculationFields(input: {
  calculationType: DeductionCalculationType;
  defaultPercentage?: number;
  defaultAmount?: number;
}): { defaultPercentage: number | null; defaultAmount: number | null } {
  if (input.calculationType === "PERCENTAGE") {
    return { defaultPercentage: input.defaultPercentage ?? null, defaultAmount: null };
  }
  return { defaultPercentage: null, defaultAmount: input.defaultAmount ?? null };
}

async function assertNoDuplicateName(deductionType: DeductionType, name: string, excludeId?: string): Promise<void> {
  const match: Record<string, unknown> = {
    deductionType,
    name: { $regex: `^${escapeRegex(name.trim())}$`, $options: "i" },
  };
  if (excludeId) match._id = { $ne: excludeId };
  const existing = await DeductionMasterModel.findOne(match).select("name");
  if (existing) {
    throw new AppError(409, `A ${deductionType === "VENDOR" ? "Vendor" : "Employee"} deduction named "${existing.name}" already exists.`, {
      name: ["Already exists for this Deduction Type."],
    });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function createDeductionMaster(input: CreateDeductionMasterInput, context: ActorContext): Promise<DeductionMasterDto> {
  const actorId = requireActorId(context);
  await assertNoDuplicateName(input.deductionType, input.name);
  const { defaultPercentage, defaultAmount } = normalizeCalculationFields(input);

  const doc = await DeductionMasterModel.create({
    name: input.name.trim(),
    deductionType: input.deductionType,
    calculationType: input.calculationType,
    defaultPercentage,
    defaultAmount,
    isActive: input.isActive ?? true,
    displayOrder: input.displayOrder ?? 0,
    remarks: input.remarks?.trim() || null,
    createdBy: actorId,
    updatedBy: actorId,
  });

  await logActivity({
    user: actorId,
    action: "MASTER_DATA_CREATED",
    module: "MASTER_DATA",
    description: `Created ${input.deductionType === "VENDOR" ? "Vendor" : "Employee"} deduction "${doc.name}".`,
    entityType: "DeductionMaster",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(doc);
}

async function findByIdOr404(id: string): Promise<DeductionMasterDocument> {
  const doc = await DeductionMasterModel.findById(id);
  if (!doc) throw new AppError(404, "Deduction not found.");
  return doc;
}

export async function getDeductionMasterById(id: string): Promise<DeductionMasterDto> {
  const doc = await findByIdOr404(id);
  return serialize(doc);
}

export async function updateDeductionMaster(id: string, input: UpdateDeductionMasterInput, context: ActorContext): Promise<DeductionMasterDto> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id);
  await assertNoDuplicateName(input.deductionType, input.name, id);
  const { defaultPercentage, defaultAmount } = normalizeCalculationFields(input);

  doc.name = input.name.trim();
  doc.deductionType = input.deductionType;
  doc.calculationType = input.calculationType;
  doc.defaultPercentage = defaultPercentage;
  doc.defaultAmount = defaultAmount;
  doc.isActive = input.isActive ?? true;
  doc.displayOrder = input.displayOrder ?? 0;
  doc.remarks = input.remarks?.trim() || null;
  doc.updatedBy = actorId;
  await doc.save();

  await logActivity({
    user: actorId,
    action: "MASTER_DATA_UPDATED",
    module: "MASTER_DATA",
    description: `Updated ${doc.deductionType === "VENDOR" ? "Vendor" : "Employee"} deduction "${doc.name}".`,
    entityType: "DeductionMaster",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(doc);
}

export async function setDeductionMasterActive(id: string, isActive: boolean, context: ActorContext): Promise<DeductionMasterDto> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id);
  doc.isActive = isActive;
  doc.updatedBy = actorId;
  await doc.save();

  await logActivity({
    user: actorId,
    action: isActive ? "MASTER_DATA_UPDATED" : "MASTER_DATA_DEACTIVATED",
    module: "MASTER_DATA",
    description: `${isActive ? "Activated" : "Deactivated"} deduction "${doc.name}".`,
    entityType: "DeductionMaster",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return serialize(doc);
}

export async function deleteDeductionMaster(id: string, context: ActorContext): Promise<void> {
  const actorId = requireActorId(context);
  const doc = await findByIdOr404(id);
  // No transaction module references DeductionMaster yet (§12 — once one
  // does, it stores a standalone snapshot rather than a live reference, so
  // deleting a master record is never expected to need an in-use check the
  // way Node Type's does).
  await DeductionMasterModel.deleteOne({ _id: doc._id });

  await logActivity({
    user: actorId,
    action: "MASTER_DATA_DEACTIVATED",
    module: "MASTER_DATA",
    description: `Deleted ${doc.deductionType === "VENDOR" ? "Vendor" : "Employee"} deduction "${doc.name}".`,
    entityType: "DeductionMaster",
    entityId: doc._id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

function buildListMatch(query: DeductionMasterListQuery | DeductionMasterExportQuery): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (query.deductionType) match.deductionType = query.deductionType;
  if (query.isActive !== undefined) match.isActive = query.isActive;
  if (query.search) match.name = { $regex: escapeRegex(query.search), $options: "i" };
  return match;
}

export async function listDeductionMasters(query: DeductionMasterListQuery): Promise<ListResult<DeductionMasterDto>> {
  const match = buildListMatch(query);
  const [docs, total] = await Promise.all([
    DeductionMasterModel.find(match)
      .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    DeductionMasterModel.countDocuments(match),
  ]);

  return {
    items: docs.map(serialize),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
  };
}

export function getDeductionMastersCursorForExport(query: DeductionMasterExportQuery) {
  const match = buildListMatch(query);
  return DeductionMasterModel.find(match)
    .sort({ [query.sortBy]: query.sortOrder === "asc" ? 1 : -1 })
    .cursor();
}
