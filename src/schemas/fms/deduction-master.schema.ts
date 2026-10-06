import { z } from "zod";
import { DEDUCTION_TYPES, DEDUCTION_CALCULATION_TYPES } from "../../models/fms/DeductionMaster";

export const deductionTypeEnum = z.enum(DEDUCTION_TYPES);
export const deductionCalculationTypeEnum = z.enum(DEDUCTION_CALCULATION_TYPES);

const baseDeductionMasterFields = {
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(150),
  deductionType: deductionTypeEnum,
  calculationType: deductionCalculationTypeEnum,
  defaultPercentage: z.coerce.number().min(0, "Cannot be negative.").max(100, "Cannot exceed 100%.").optional(),
  defaultAmount: z.coerce.number().min(0, "Cannot be negative.").optional(),
  isActive: z.boolean().optional().default(true),
  displayOrder: z.coerce.number().int("Display order must be a whole number.").min(0).optional().default(0),
  remarks: z.string().trim().max(500).optional(),
};

export const createDeductionMasterSchema = z.object(baseDeductionMasterFields);
export const updateDeductionMasterSchema = z.object(baseDeductionMasterFields);

export const setDeductionMasterActiveSchema = z.object({
  isActive: z.boolean(),
});

export const DEDUCTION_MASTER_SORT_KEYS = ["createdAt", "name", "displayOrder", "deductionType"] as const;

export const deductionMasterListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  deductionType: deductionTypeEnum.optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sortBy: z.enum(DEDUCTION_MASTER_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const deductionMasterExportQuerySchema = deductionMasterListQuerySchema.omit({ page: true, limit: true });

export type CreateDeductionMasterInput = z.infer<typeof createDeductionMasterSchema>;
export type UpdateDeductionMasterInput = z.infer<typeof updateDeductionMasterSchema>;
export type DeductionMasterListQuery = z.infer<typeof deductionMasterListQuerySchema>;
export type DeductionMasterExportQuery = z.infer<typeof deductionMasterExportQuerySchema>;
