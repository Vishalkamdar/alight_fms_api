/**
 * One-time bootstrap for creating a user directly in the database —
 * intentionally NOT env-var driven. Every credential is passed as a CLI
 * argument at invocation time and only ever persisted as a normal User
 * document (hashed password, via the same schema/validation the API uses).
 * Nothing about a user's identity lives in .env.
 *
 * Usage:
 *   npm run create:user -- \
 *     --fullname="Jane Doe" --email="jane@example.com" --password="Str0ng!Pass" \
 *     --countryCode="+91" --phone="9876543210" --role="Super Admin"
 *
 * --role defaults to "Admin" if omitted. Only "Super Admin" and "Admin" are
 * valid (see models/User.ts). Re-running with an existing email updates
 * that user's role instead of creating a duplicate.
 */
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { UserModel, USER_ROLES, type UserRole } from "../models/User";
import { hashPassword } from "../utils/password";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const token of argv) {
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(token);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const role = (args.role ?? "Admin") as UserRole;

  if (!USER_ROLES.includes(role)) {
    console.error(`Invalid --role "${role}". Must be one of: ${USER_ROLES.join(", ")}`);
    process.exit(1);
  }

  await connectDatabase();

  const email = args.email?.toLowerCase().trim();
  if (!email) {
    console.error("Missing --email.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const existing = await UserModel.findOne({ email });
  if (existing) {
    if (existing.role === role) {
      console.log(`${email} already exists with role ${role}. Nothing to do.`);
    } else {
      const previousRole = existing.role;
      existing.role = role;
      await existing.save();
      console.log(`Updated ${email}: ${previousRole} -> ${role}`);
    }
    await mongoose.disconnect();
    return;
  }

  const missing = ["fullname", "password", "countryCode", "phone"].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`No user found with email ${email}. To create it, also pass: ${missing.map((k) => `--${k}`).join(", ")}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const password = await hashPassword(args.password);
  const user = await UserModel.create({
    fullname: args.fullname,
    email,
    password,
    countryCode: args.countryCode,
    phone: args.phone,
    role,
    isEmailVerified: true,
  });

  console.log(`Created ${role}: ${user.email} (${user._id.toString()})`);
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error("Failed to create/update user:", error);
  process.exit(1);
});
