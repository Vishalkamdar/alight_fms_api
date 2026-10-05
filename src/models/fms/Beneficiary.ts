import { Schema, model, Document, Types } from "mongoose";
import { INDIAN_STATES_AND_UTS } from "../../constants/indianStates";

export const BENEFICIARY_TYPES = ["VENDOR", "EMPLOYEE"] as const;
export type BeneficiaryType = (typeof BENEFICIARY_TYPES)[number];

export const PAYMENT_MODES = ["BANK", "CASH"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const BANK_ACCOUNT_TYPES = ["SAVINGS", "CURRENT"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

export interface BankAccount {
  _id: Types.ObjectId;
  bankName: string;
  branchName: string;
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  accountType: BankAccountType | null;
  isDefault: boolean;
}

/**
 * A single master for both Vendor and Employee beneficiaries — they share
 * almost every field (contact/address/bank details) and will both feed the
 * same future Payments module, so one collection with an explicit
 * `beneficiaryType` discriminator avoids duplicating the entire shape
 * across two models while still keeping the type as a real, queryable
 * database field (never inferred later from "does it have a GST number").
 * Vendor-only and Employee-only fields are simply null on the other type —
 * which fields are actually REQUIRED for which type is enforced entirely
 * in the service/schema layer (see beneficiary.schema.ts), never assumed
 * from the data shape alone.
 */
export interface BeneficiaryDocument extends Document {
  _id: Types.ObjectId;
  beneficiaryType: BeneficiaryType;
  /**
   * Which Organization Node (department) this beneficiary belongs to —
   * `null` means Global: visible to and usable by every department, not
   * just one. Only Super Admin/Admin may create or leave a beneficiary
   * Global; an FMS Operational User - Maker can only ever set this to one
   * of their own assigned department(s), never null and never another
   * department's node (enforced in beneficiary.service.ts, never trusted
   * from the client — see assertDepartmentScope).
   */
  organizationNodeId: Types.ObjectId | null;
  // Vendor Name / Employee Name — same field, meaning depends on type.
  name: string;
  // Vendor-only.
  contactPersonName: string | null;
  gstNumber: string | null;
  // Employee-only, unique among Employees.
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
  paymentMode: PaymentMode;
  bankAccounts: Types.DocumentArray<BankAccount>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const bankAccountSchema = new Schema<BankAccount>(
  {
    bankName: { type: String, required: true, trim: true, maxlength: 150 },
    branchName: { type: String, required: true, trim: true, maxlength: 150 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 30 },
    ifscCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 11 },
    accountHolderName: { type: String, trim: true, maxlength: 150, default: "" },
    accountType: { type: String, enum: BANK_ACCOUNT_TYPES, default: null },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: false }
);

const beneficiarySchema = new Schema<BeneficiaryDocument>(
  {
    beneficiaryType: { type: String, enum: BENEFICIARY_TYPES, required: true },
    organizationNodeId: { type: Schema.Types.ObjectId, ref: "OrganizationNode", default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    contactPersonName: { type: String, trim: true, maxlength: 150, default: null },
    gstNumber: { type: String, trim: true, uppercase: true, maxlength: 15, default: null },
    employeeId: { type: String, trim: true, maxlength: 40, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 150, default: null },
    mobile: { type: String, required: true, trim: true, maxlength: 15 },
    phone: { type: String, trim: true, maxlength: 15, default: null },
    address: { type: String, trim: true, maxlength: 500, default: null },
    area: { type: String, trim: true, maxlength: 150, default: null },
    state: { type: String, enum: [...INDIAN_STATES_AND_UTS, null], default: null },
    district: { type: String, trim: true, maxlength: 100, default: null },
    city: { type: String, trim: true, maxlength: 100, default: null },
    pincode: { type: String, trim: true, maxlength: 10, default: null },
    panNumber: { type: String, trim: true, uppercase: true, maxlength: 10, default: null },
    isActive: { type: Boolean, required: true, default: true },
    paymentMode: { type: String, enum: PAYMENT_MODES, required: true, default: "BANK" },
    bankAccounts: { type: [bankAccountSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

beneficiarySchema.index({ beneficiaryType: 1 });
beneficiarySchema.index({ beneficiaryType: 1, name: 1 });
beneficiarySchema.index({ beneficiaryType: 1, gstNumber: 1 });
beneficiarySchema.index({ beneficiaryType: 1, panNumber: 1 });
beneficiarySchema.index({ beneficiaryType: 1, employeeId: 1 });
beneficiarySchema.index({ isActive: 1 });
beneficiarySchema.index({ organizationNodeId: 1 });
beneficiarySchema.index({ state: 1 });
beneficiarySchema.index({ createdAt: -1 });

export const BeneficiaryModel = model<BeneficiaryDocument>("Beneficiary", beneficiarySchema);
