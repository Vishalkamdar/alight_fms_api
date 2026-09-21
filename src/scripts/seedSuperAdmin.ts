import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { env } from "../config/env";
import { UserModel, USER_ROLES } from "../models/User";
import { hashPassword } from "../utils/password";

/**
 * Idempotent Super Admin initialization:
 *   - If SUPER_ADMIN_EMAIL already exists, promote it to Super Admin.
 *   - Otherwise create it (requires SUPER_ADMIN_PASSWORD/COUNTRY_CODE/PHONE).
 * Also defensively migrates any leftover pre-Phase-3 role values (the old
 * "Business Head"/"Business Manager"/"Accountant" enum) to "Admin", since
 * those are no longer valid application roles.
 */
async function seedSuperAdmin(): Promise<void> {
  await connectDatabase();

  const email = env.SUPER_ADMIN_EMAIL.toLowerCase();
  const existing = await UserModel.findOne({ email });

  if (existing) {
    if (existing.role === "Super Admin") {
      console.log(`${email} is already Super Admin.`);
    } else {
      const previousRole = existing.role;
      existing.role = "Super Admin";
      await existing.save();
      console.log(`Updated ${email}: ${previousRole} -> Super Admin`);
    }
  } else {
    if (!env.SUPER_ADMIN_PASSWORD || !env.SUPER_ADMIN_COUNTRY_CODE || !env.SUPER_ADMIN_PHONE) {
      console.error(
        `No user found with email ${email}. To create it, set SUPER_ADMIN_PASSWORD, SUPER_ADMIN_COUNTRY_CODE, and SUPER_ADMIN_PHONE in .env and re-run this script.`
      );
      process.exit(1);
    }

    const password = await hashPassword(env.SUPER_ADMIN_PASSWORD);
    await UserModel.create({
      fullname: env.SUPER_ADMIN_NAME ?? "Super Admin",
      email,
      password,
      countryCode: env.SUPER_ADMIN_COUNTRY_CODE,
      phone: env.SUPER_ADMIN_PHONE,
      role: "Super Admin",
      isEmailVerified: true,
    });
    console.log(`Super Admin created: ${email}`);
  }

  const legacyRoleUsers = await UserModel.find({ role: { $nin: USER_ROLES } });
  if (legacyRoleUsers.length > 0) {
    await UserModel.updateMany({ role: { $nin: USER_ROLES } }, { $set: { role: "Admin" } });
    console.log(
      `Migrated ${legacyRoleUsers.length} user(s) with a retired role to "Admin": ${legacyRoleUsers
        .map((u) => u.email)
        .join(", ")}`
    );
  }

  await mongoose.disconnect();
}

seedSuperAdmin().catch((error: unknown) => {
  console.error("Failed to seed Super Admin:", error);
  process.exit(1);
});
