import { z } from "zod";
import { objectIdSchema } from "../common.schema";
import { EXPENDITURE_PAYMENT_TYPES } from "../../models/fms/Expenditure";
import { BENEFICIARY_TYPES } from "../../models/fms/Beneficiary";
import { APPROVAL_STATUSES } from "../../types/fms/financial-workflow.types";
import { EXPENDITURE_PAYMENT_STATUSES } from "../../models/fms/Expenditure";

const particularInputSchema = z.object({
  description: z.string().trim().min(1, "Particular/Description is required.").max(300),
  amount: z.coerce.number().positive("Amount must be positive."),
});

export const CGST_SGST_SLABS = [0, 2.5, 6, 9, 14] as const;
export const IGST_SLABS = [0, 5, 12, 18, 28] as const;

const baseExpenditureFields = {
  financialYearId: objectIdSchema,
  organizationRootNodeId: objectIdSchema,
  organizationNodeId: objectIdSchema,
  schemeHeadRootNodeId: objectIdSchema,
  headId: objectIdSchema,

  beneficiaryType: z.enum(BENEFICIARY_TYPES),
  beneficiaryId: objectIdSchema,
  paymentType: z.enum(EXPENDITURE_PAYMENT_TYPES),

  billVoucherNumber: z.string().trim().min(1, "Bill/Voucher Number is required.").max(60),
  billVoucherDate: z.coerce.date({ error: "Bill/Voucher Date is required." }),
  debitNarration: z.string().trim().max(500).optional(),
  creditNarration: z.string().trim().max(500).optional(),
  remarks: z.string().trim().max(1000).optional(),
  enrichment1: z.string().trim().max(200).optional(),
  enrichment2: z.string().trim().max(200).optional(),

  particulars: z.array(particularInputSchema).min(1, "At least one Particular is required."),

  // CGST+SGST and IGST are mutually exclusive tax modes (§4/§8) — enforced
  // below in applyTaxRules, not just by the frontend's auto-switching
  // dropdowns. Only these specific slabs are ever valid, matching the
  // dropdown options exactly.
  cgstPercent: z.coerce.number().refine((v) => (CGST_SGST_SLABS as readonly number[]).includes(v), "Invalid CGST rate.").optional().default(0),
  sgstPercent: z.coerce.number().refine((v) => (CGST_SGST_SLABS as readonly number[]).includes(v), "Invalid SGST rate.").optional().default(0),
  igstPercent: z.coerce.number().refine((v) => (IGST_SLABS as readonly number[]).includes(v), "Invalid IGST rate.").optional().default(0),

  // The Maker can enter either a Percentage or a Rs. amount per selected
  // deduction (matching the reference "Specify Deductions" table) — `amount`
  // is the one that actually gets deducted, `percentage` is kept only as
  // informational snapshot context. The deductionId itself is always
  // re-verified server-side (Active, Vendor-type) — see
  // resolveVendorDeductionSnapshots in expenditure.service.ts. Entirely
  // ignored when beneficiaryType is EMPLOYEE (§9) — enforced in the service
  // layer, not just by the frontend hiding the section.
  deductions: z
    .array(
      z.object({
        deductionId: objectIdSchema,
        percentage: z.coerce.number().min(0).max(100).optional(),
        amount: z.coerce.number().min(0, "Deduction amount cannot be negative."),
      })
    )
    .max(50)
    .optional()
    .default([]),
};

/**
 * §4/§8 — CGST+SGST and IGST can never both be active, and SGST must
 * always mirror CGST's rate (the frontend's dropdown auto-sets this, but a
 * crafted request must not be able to submit CGST=9/SGST=9/IGST=18, or
 * mismatched CGST≠SGST, and have it accepted).
 */
function applyTaxRules<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data: z.infer<typeof schema>, ctx) => {
    const d = data as z.infer<typeof schema> & { cgstPercent: number; sgstPercent: number; igstPercent: number };
    if (d.cgstPercent > 0 && d.igstPercent > 0) {
      ctx.addIssue({ code: "custom", path: ["igstPercent"], message: "CGST+SGST and IGST cannot both be active." });
    }
    if (d.sgstPercent > 0 && d.igstPercent > 0) {
      ctx.addIssue({ code: "custom", path: ["igstPercent"], message: "CGST+SGST and IGST cannot both be active." });
    }
    if (d.cgstPercent !== d.sgstPercent) {
      ctx.addIssue({ code: "custom", path: ["sgstPercent"], message: "SGST must equal CGST — they always move together." });
    }
  });
}

export const createExpenditureSchema = applyTaxRules(z.object(baseExpenditureFields));
export const updateExpenditureSchema = applyTaxRules(z.object(baseExpenditureFields));

export const EXPENDITURE_SORT_KEYS = ["createdAt", "billVoucherDate", "netPayableAmount", "billVoucherNumber"] as const;

export const expenditureListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  beneficiaryType: z.enum(BENEFICIARY_TYPES).optional(),
  beneficiaryId: objectIdSchema.optional(),
  organizationNodeId: objectIdSchema.optional(),
  schemeHeadRootNodeId: objectIdSchema.optional(),
  headId: objectIdSchema.optional(),
  financialYearId: objectIdSchema.optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  paymentStatus: z.enum(EXPENDITURE_PAYMENT_STATUSES).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  amountFrom: z.coerce.number().min(0).optional(),
  amountTo: z.coerce.number().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(EXPENDITURE_SORT_KEYS).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const expenditureExportQuerySchema = expenditureListQuerySchema.omit({ page: true, limit: true });

export type CreateExpenditureInput = z.infer<typeof createExpenditureSchema>;
export type UpdateExpenditureInput = z.infer<typeof updateExpenditureSchema>;
export type ExpenditureListQuery = z.infer<typeof expenditureListQuerySchema>;
export type ExpenditureExportQuery = z.infer<typeof expenditureExportQuerySchema>;
