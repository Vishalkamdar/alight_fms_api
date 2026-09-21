import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { env } from "../config/env";
import { UserModel } from "../models/User";
import { hashPassword } from "../utils/password";

async function seedAdmin(): Promise<void> {
  if (
    !env.SEED_ADMIN_EMAIL ||
    !env.SEED_ADMIN_PASSWORD ||
    !env.SEED_ADMIN_COUNTRY_CODE ||
    !env.SEED_ADMIN_PHONE
  ) {
    console.error(
      "SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_COUNTRY_CODE, and SEED_ADMIN_PHONE must all be set in .env to seed an admin user."
    );
    process.exit(1);
  }

  await connectDatabase();

  const email = env.SEED_ADMIN_EMAIL.toLowerCase();
  const existing = await UserModel.findOne({ email });

  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    await mongoose.disconnect();
    return;
  }

  const password = await hashPassword(env.SEED_ADMIN_PASSWORD);
  await UserModel.create({
    fullname: env.SEED_ADMIN_NAME ?? "Admin",
    email,
    password,
    countryCode: env.SEED_ADMIN_COUNTRY_CODE,
    phone: env.SEED_ADMIN_PHONE,
    role: "Admin",
    isEmailVerified: true,
  });

  console.log(`Admin user created: ${email}`);
  await mongoose.disconnect();
}

seedAdmin().catch((error: unknown) => {
  console.error("Failed to seed admin user:", error);
  process.exit(1);
});
