/**
 * Resets passwords for the 6 UAT test users (role/node assignments already
 * exist from _UAT_1_provisionUsers.ts — this script only touches
 * passwords) and prints a fresh credentials table.
 *
 * Passwords follow a fixed, memorable scheme for manual testing
 * (`<email-local-part>@123`, e.g. root.maker@123) rather than random
 * generation — set by explicit request, bypasses the normal password
 * complexity policy since this writes the hash directly, not through the
 * validated change-password API.
 *
 * Usage: npx tsx src/scripts/_UAT_3_resetPasswords.ts
 */
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { UserModel } from "../models/User";
import { hashPassword } from "../utils/password";

function fixedPassword(email: string): string {
  return `${email.split("@")[0]}@123`;
}

const USERS = [
  { email: "root.maker@alight-fms.local", department: "Alight Consultants (Root)", systemRole: "Admin", fmsRole: "Maker" },
  { email: "root.verifier@alight-fms.local", department: "Alight Consultants (Root)", systemRole: "FMS Operational User - Verifier", fmsRole: "Verifier" },
  { email: "root.checker@alight-fms.local", department: "Alight Consultants (Root)", systemRole: "FMS Operational User - Checker", fmsRole: "Checker" },
  { email: "tech.maker@alight-fms.local", department: "Tech", systemRole: "FMS Operational User - Maker", fmsRole: "Maker" },
  { email: "tech.verifier@alight-fms.local", department: "Tech", systemRole: "FMS Operational User - Verifier", fmsRole: "Verifier" },
  { email: "tech.checker@alight-fms.local", department: "Tech", systemRole: "FMS Operational User - Checker", fmsRole: "Checker" },
];

async function main() {
  await connectDatabase();

  const rows: Array<(typeof USERS)[number] & { password: string; fullname: string }> = [];

  for (const spec of USERS) {
    const user = await UserModel.findOne({ email: spec.email });
    if (!user) throw new Error(`${spec.email} not found — run _UAT_1_provisionUsers.ts first.`);

    const password = fixedPassword(spec.email);
    user.password = await hashPassword(password);
    user.isActive = true;
    await user.save();

    rows.push({ ...spec, password, fullname: user.fullname });
    console.log(`Reset password for ${spec.email}`);
  }

  console.log("\n=== UAT Test Logins ===");
  for (const r of rows) {
    console.log(`${r.department.padEnd(26)} ${r.fmsRole.padEnd(10)} ${r.email.padEnd(32)} ${r.password}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
