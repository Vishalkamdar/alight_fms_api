import { Schema, model, Document, Types } from "mongoose";

export const FINANCIAL_YEAR_STATUSES = ["OPEN", "CLOSED"] as const;
export type FinancialYearStatus = (typeof FINANCIAL_YEAR_STATUSES)[number];

/**
 * The Indian Financial Year (1 April → 31 March), e.g. "2026-27". Every
 * future FMS transaction module (Invoice, Payment, Payroll, Budget/Fund
 * Allocation, ...) references a document here by `financialYearId` instead
 * of implementing its own year logic — see services/financial-year.service.ts.
 */
export interface FinancialYearDocument extends Document {
  _id: Types.ObjectId;
  financialYear: string;
  startDate: Date;
  endDate: Date;
  status: FinancialYearStatus;
  isCurrent: boolean;
  isClosed: boolean;
  previousYearEntryAllowed: boolean;
  previousYearEntryEnabledAt: Date | null;
  previousYearEntryEnabledBy: Types.ObjectId | null;
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  reopenedAt: Date | null;
  reopenedBy: Types.ObjectId | null;
  reopenReason: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const financialYearSchema = new Schema<FinancialYearDocument>(
  {
    financialYear: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      match: [/^\d{4}-\d{2}$/, "Financial year must be in YYYY-YY format, e.g. 2026-27."],
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: FINANCIAL_YEAR_STATUSES, default: "OPEN" },
    isCurrent: { type: Boolean, default: false },
    isClosed: { type: Boolean, default: false },
    previousYearEntryAllowed: { type: Boolean, default: false },
    previousYearEntryEnabledAt: { type: Date, default: null },
    previousYearEntryEnabledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenReason: { type: String, trim: true, maxlength: 1000, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

financialYearSchema.index({ startDate: 1 });
financialYearSchema.index({ endDate: 1 });
financialYearSchema.index({ status: 1 });
// Only one document may ever have isCurrent: true at a time — enforced at
// the database level, not just in application logic.
financialYearSchema.index(
  { isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } }
);

export const FinancialYearModel = model<FinancialYearDocument>("FinancialYear", financialYearSchema);
