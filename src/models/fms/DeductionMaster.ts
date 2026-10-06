import { Schema, model, Document, Types } from "mongoose";

export type FmsStatus = "Active" | "Inactive";

/** Which transaction type a deduction can be used on — Vendor Expenditure or Employee Payment, never both. */
export const DEDUCTION_TYPES = ["VENDOR", "EMPLOYEE"] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

export const DEDUCTION_CALCULATION_TYPES = ["PERCENTAGE", "FIXED_AMOUNT"] as const;
export type DeductionCalculationType = (typeof DEDUCTION_CALCULATION_TYPES)[number];

/**
 * A single reusable deduction component (TDS, EPF, Security Deposit, ...)
 * that Vendor Expenditure / Employee Payment transactions pick from instead
 * of hardcoding deduction checkboxes in those forms. `deductionType` keeps
 * Vendor and Employee components in one master but strictly separated — a
 * Vendor transaction can never be offered or accept an Employee deduction
 * and vice versa, enforced in deduction-master.service.ts and again by
 * whatever transaction module consumes this later (never inferred from the
 * name alone).
 *
 * Renaming, deactivating, or changing a deduction's calculation rules here
 * must NEVER retroactively change a past transaction — any consumer is
 * expected to snapshot {deductionId, deductionName, deductionType,
 * calculationType, percentage, fixedAmount, calculatedAmount} onto the
 * transaction at the time it's used, rather than re-reading this master.
 */
export interface DeductionMasterDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  deductionType: DeductionType;
  calculationType: DeductionCalculationType;
  /** Only meaningful when calculationType is PERCENTAGE; 0-100. */
  defaultPercentage: number | null;
  /** Only meaningful when calculationType is FIXED_AMOUNT; >= 0. */
  defaultAmount: number | null;
  isActive: boolean;
  displayOrder: number;
  remarks: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const deductionMasterSchema = new Schema<DeductionMasterDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },
    deductionType: { type: String, enum: DEDUCTION_TYPES, required: true },
    calculationType: { type: String, enum: DEDUCTION_CALCULATION_TYPES, required: true },
    defaultPercentage: { type: Number, min: 0, max: 100, default: null },
    defaultAmount: { type: Number, min: 0, default: null },
    isActive: { type: Boolean, required: true, default: true },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    remarks: { type: String, trim: true, maxlength: 500, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

deductionMasterSchema.index({ deductionType: 1, isActive: 1 });
deductionMasterSchema.index({ deductionType: 1, name: 1 }, { unique: true });
deductionMasterSchema.index({ displayOrder: 1 });
deductionMasterSchema.index({ createdAt: -1 });

export const DeductionMasterModel = model<DeductionMasterDocument>("DeductionMaster", deductionMasterSchema);
