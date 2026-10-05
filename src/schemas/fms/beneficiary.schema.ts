import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { BENEFICIARY_TYPES, PAYMENT_MODES, BANK_ACCOUNT_TYPES } from "../../models/fms/Beneficiary";
import { INDIAN_STATES_AND_UTS } from "../../constants/indianStates";

// Standard Indian formats.
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const PINCODE_REGEX = /^\d{6}$/;

export const bankAccountSchema = z.object({
  _id: z.string().optional(),
  bankName: z.string().trim().min(1, "Bank Name is required.").max(150),
  branchName: z.string().trim().min(1, "Branch Name is required.").max(150),
  accountNumber: z.string().trim().min(1, "A/C Number is required.").max(30),
  ifscCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(IFSC_REGEX, "Invalid IFSC Code format (e.g. HDFC0001234)."),
  accountHolderName: z.string().trim().max(150).optional().default(""),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable().optional(),
  isDefault: z.boolean().optional().default(false),
});

const baseBeneficiaryFields = {
  beneficiaryType: z.enum(BENEFICIARY_TYPES),
  name: z.string().trim().min(1, "Name is required.").max(200),
  contactPersonName: z.string().trim().max(150).optional(),
  employeeId: z.string().trim().max(40).optional(),
  email: z.string().trim().toLowerCase().email("Invalid email address.").optional().or(z.literal("")),
  mobile: z.string().trim().regex(MOBILE_REGEX, "Enter a valid 10-digit mobile number."),
  phone: z.string().trim().max(15).optional(),
  address: z.string().trim().max(500).optional(),
  area: z.string().trim().max(150).optional(),
  state: z.enum(INDIAN_STATES_AND_UTS, { error: "Select a valid State / Union Territory." }),
  district: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  pincode: z.string().trim().regex(PINCODE_REGEX, "Enter a valid 6-digit pincode.").optional().or(z.literal("")),
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN_REGEX, "Invalid PAN format (e.g. ABCDE1234F).")
    .optional()
    .or(z.literal("")),
  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GST_REGEX, "Invalid GST format (e.g. 22ABCDE1234F1Z5).")
    .optional()
    .or(z.literal("")),
  isActive: z.boolean().optional().default(true),
  paymentMode: z.enum(PAYMENT_MODES).optional().default("BANK"),
  bankAccounts: z.array(bankAccountSchema).max(20).optional().default([]),
};

/**
 * Vendor requires GST (spec §2 — mandatory unless a future config exception
 * is added, which doesn't exist yet) and a Contact Person; Employee requires
 * an Employee ID and PAN but never GST — these per-type rules are the real
 * authorization/data-integrity boundary (§18 — a crafted request can't get
 * around them by omitting beneficiaryType-specific checks), so they're
 * enforced here in the schema, not just hinted at in the frontend form.
 */
function applyBeneficiaryTypeRules<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data: z.infer<typeof schema>, ctx) => {
    const d = data as z.infer<typeof schema> & {
      beneficiaryType: "VENDOR" | "EMPLOYEE";
      contactPersonName?: string;
      gstNumber?: string;
      employeeId?: string;
      panNumber?: string;
      paymentMode: "BANK" | "CASH";
      bankAccounts: Array<{ isDefault?: boolean }>;
    };

    if (d.beneficiaryType === "VENDOR") {
      if (!d.contactPersonName) {
        ctx.addIssue({ code: "custom", path: ["contactPersonName"], message: "Contact Person Name is required for a Vendor." });
      }
      if (!d.gstNumber) {
        ctx.addIssue({ code: "custom", path: ["gstNumber"], message: "GST Number is required for a Vendor." });
      }
    } else {
      if (!d.employeeId) {
        ctx.addIssue({ code: "custom", path: ["employeeId"], message: "Employee ID is required for an Employee." });
      }
      if (!d.panNumber) {
        ctx.addIssue({ code: "custom", path: ["panNumber"], message: "PAN Number is required for an Employee." });
      }
      if (d.gstNumber) {
        ctx.addIssue({ code: "custom", path: ["gstNumber"], message: "GST Number is not applicable for an Employee." });
      }
    }

    if (d.paymentMode === "BANK") {
      if (d.bankAccounts.length === 0) {
        ctx.addIssue({ code: "custom", path: ["bankAccounts"], message: "At least one bank account is required when not paying by cash." });
      } else {
        const defaultCount = d.bankAccounts.filter((b) => b.isDefault).length;
        if (defaultCount === 0) {
          ctx.addIssue({ code: "custom", path: ["bankAccounts"], message: "Mark exactly one bank account as Default." });
        } else if (defaultCount > 1) {
          ctx.addIssue({ code: "custom", path: ["bankAccounts"], message: "Only one bank account may be marked as Default." });
        }
      }
    }
  });
}

export const createBeneficiarySchema = applyBeneficiaryTypeRules(z.object(baseBeneficiaryFields));
export const updateBeneficiarySchema = applyBeneficiaryTypeRules(z.object(baseBeneficiaryFields));

export const BENEFICIARY_SORT_KEYS = ["createdAt", "name", "beneficiaryType", "state", "isActive"] as const;

export const beneficiaryListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  beneficiaryType: z.enum(BENEFICIARY_TYPES).optional(),
  employeeId: z.string().trim().max(40).optional(),
  panNumber: z.string().trim().max(10).optional(),
  gstNumber: z.string().trim().max(15).optional(),
  state: z.enum(INDIAN_STATES_AND_UTS).optional(),
  city: z.string().trim().max(100).optional(),
  isActive: z.coerce.boolean().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(BENEFICIARY_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const beneficiaryExportQuerySchema = beneficiaryListQuerySchema.omit({ page: true, limit: true });

export type CreateBeneficiaryInput = z.infer<typeof createBeneficiarySchema>;
export type UpdateBeneficiaryInput = z.infer<typeof updateBeneficiarySchema>;
export type BeneficiaryListQuery = z.infer<typeof beneficiaryListQuerySchema>;
export type BeneficiaryExportQuery = z.infer<typeof beneficiaryExportQuerySchema>;
export type BankAccountInput = z.infer<typeof bankAccountSchema>;
