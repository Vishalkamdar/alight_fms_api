import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { UserModel } from "../models/User";
import { hashPassword } from "../utils/password";

async function main(): Promise<void> {
  await connectDatabase();
  const password = await hashPassword("TestSuperP@ss1");
  const user = await UserModel.create({
    fullname: "Test Super Admin",
    email: "test.superadmin@example.com",
    password,
    countryCode: "+91",
    phone: "9000000001",
    role: "Super Admin",
    isEmailVerified: true,
  });
  console.log("Created test super admin:", user._id.toString());
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
