/**
 * One-time bootstrap for the initial Deduction Master records (§3/§4 of the
 * Deduction Master spec). Idempotent — re-running skips any
 * (deductionType, name) pair that already exists rather than duplicating it.
 *
 * Usage: npx tsx src/scripts/seedDeductionMasters.ts
 */
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { DeductionMasterModel } from "../models/fms/DeductionMaster";
import { UserModel } from "../models/User";

const VENDOR_DEDUCTIONS = [
  { name: "TDS", calculationType: "PERCENTAGE" as const, defaultPercentage: 10 },
  { name: "TDS on GST", calculationType: "PERCENTAGE" as const, defaultPercentage: 2 },
  { name: "Security Deposit", calculationType: "FIXED_AMOUNT" as const },
  { name: "Penalties", calculationType: "FIXED_AMOUNT" as const },
  { name: "Others", calculationType: "FIXED_AMOUNT" as const },
];

const EMPLOYEE_DEDUCTIONS = [
  { name: "EPF", calculationType: "PERCENTAGE" as const, defaultPercentage: 12 },
  { name: "ESI", calculationType: "PERCENTAGE" as const, defaultPercentage: 0.75 },
  { name: "Professional Tax (PT)", calculationType: "FIXED_AMOUNT" as const },
  { name: "Labour Welfare Fund (LWF)", calculationType: "FIXED_AMOUNT" as const },
  { name: "Company Loan", calculationType: "FIXED_AMOUNT" as const },
  { name: "Asset Deduction", calculationType: "FIXED_AMOUNT" as const },
];

async function main(): Promise<void> {
  await connectDatabase();

  const superAdmin = await UserModel.findOne({ role: "Super Admin" }).select("_id").lean();
  const createdBy = superAdmin?._id ?? null;

  let created = 0;
  let skipped = 0;

  for (const [deductionType, records] of [
    ["VENDOR", VENDOR_DEDUCTIONS],
    ["EMPLOYEE", EMPLOYEE_DEDUCTIONS],
  ] as const) {
    for (const [index, record] of records.entries()) {
      const existing = await DeductionMasterModel.findOne({ deductionType, name: record.name });
      if (existing) {
        skipped += 1;
        console.log(`Skipped (already exists): ${deductionType} / ${record.name}`);
        continue;
      }

      await DeductionMasterModel.create({
        name: record.name,
        deductionType,
        calculationType: record.calculationType,
        defaultPercentage: "defaultPercentage" in record ? record.defaultPercentage : null,
        defaultAmount: null,
        isActive: true,
        displayOrder: index,
        remarks: null,
        createdBy,
        updatedBy: createdBy,
      });
      created += 1;
      console.log(`Created: ${deductionType} / ${record.name}`);
    }
  }

  console.log(`\nDone — ${created} created, ${skipped} skipped (already existed).`);
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  console.error("Failed to seed deduction masters:", error);
  await mongoose.disconnect();
  process.exit(1);
});
