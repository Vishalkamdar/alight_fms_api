/**
 * UAT provisioning (phase 1 of 2) — creates the 6 test users and their
 * exact node-role assignments from the "Financial Year Controls" UAT
 * workbook's user table, via the real createUser/createAssignment
 * services (not raw inserts), acting as the existing Super Admin.
 *
 * Usage: npx tsx src/scripts/_UAT_1_provisionUsers.ts
 */
import mongoose, { Types } from "mongoose";
import crypto from "crypto";
import { connectDatabase } from "../config/db";
import { UserModel } from "../models/User";
import { OrganizationNodeModel } from "../models/OrganizationNode";
import { createUser } from "../services/fms/user.service";
import { createAssignment } from "../services/fms/user-node-role.service";
import { hashPassword } from "../utils/password";
import type { UserRole } from "../models/User";
import type { FmsRole } from "../models/fms/FmsUserNodeRole";

const SUPER_ADMIN_EMAIL = "vishal.kamdar@alightconsultants.in";

function randomPassword(): string {
  // 8+ chars, upper, lower, digit, special — matches PASSWORD_POLICY_REGEX.
  const special = "!@#$%";
  const body = crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "x");
  return `Uat${body}${special[Math.floor(Math.random() * special.length)]}9`;
}

function randomPhone(seed: number): string {
  // 10-digit, starts 6-9, deterministic-ish per row but unlikely to collide.
  return `9${String(700000000 + seed).padStart(9, "0")}`;
}

interface UserSpec {
  key: string;
  fullname: string;
  email: string;
  role: UserRole;
  nodeName: "Alight Consultants" | "Tech";
  fmsRole: FmsRole;
}

const USERS: UserSpec[] = [
  { key: "rootMaker", fullname: "UAT Root Maker", email: "root.maker@alight-fms.local", role: "Admin", nodeName: "Alight Consultants", fmsRole: "Maker" },
  { key: "rootVerifier", fullname: "UAT Root Verifier", email: "root.verifier@alight-fms.local", role: "FMS Operational User - Verifier", nodeName: "Alight Consultants", fmsRole: "Verifier" },
  { key: "rootChecker", fullname: "UAT Root Checker", email: "root.checker@alight-fms.local", role: "FMS Operational User - Checker", nodeName: "Alight Consultants", fmsRole: "Checker" },
  { key: "techMaker", fullname: "UAT Tech Maker", email: "tech.maker@alight-fms.local", role: "FMS Operational User - Maker", nodeName: "Tech", fmsRole: "Maker" },
  { key: "techVerifier", fullname: "UAT Tech Verifier", email: "tech.verifier@alight-fms.local", role: "FMS Operational User - Verifier", nodeName: "Tech", fmsRole: "Verifier" },
  { key: "techChecker", fullname: "UAT Tech Checker", email: "tech.checker@alight-fms.local", role: "FMS Operational User - Checker", nodeName: "Tech", fmsRole: "Checker" },
];

async function main() {
  await connectDatabase();

  const superAdmin = await UserModel.findOne({ email: SUPER_ADMIN_EMAIL }).select("_id role");
  if (!superAdmin) throw new Error(`Super Admin ${SUPER_ADMIN_EMAIL} not found.`);

  const nodes = await OrganizationNodeModel.find({ name: { $in: ["Alight Consultants", "Tech"] } }).select("_id name");
  const nodeByName = new Map(nodes.map((n) => [n.name, n._id as Types.ObjectId]));

  const context = { actorId: superAdmin._id as Types.ObjectId, actorRole: "Super Admin" as UserRole, ipAddress: "127.0.0.1", userAgent: "uat-provisioning-script" };

  const credentials: Array<{ key: string; email: string; password: string; role: string; node: string; fmsRole: string }> = [];

  for (const spec of USERS) {
    const nodeId = nodeByName.get(spec.nodeName);
    if (!nodeId) throw new Error(`Organization node "${spec.nodeName}" not found.`);

    const existing = await UserModel.findOne({ email: spec.email });
    let userId: Types.ObjectId;
    let password: string;

    if (existing) {
      password = randomPassword();
      existing.password = await hashPassword(password);
      existing.isActive = true;
      await existing.save();
      userId = existing._id as Types.ObjectId;
      console.log(`Reset password for existing ${spec.email}`);
    } else {
      password = randomPassword();
      const created = await createUser(
        {
          fullname: spec.fullname,
          email: spec.email,
          password,
          countryCode: "+91",
          phone: randomPhone(USERS.indexOf(spec)),
          role: spec.role,
        },
        context
      );
      userId = new Types.ObjectId(created._id);
      console.log(`Created ${spec.email} (role=${spec.role})`);
    }

    await createAssignment({ user: String(userId), node: String(nodeId), role: spec.fmsRole }, context.actorId, {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    console.log(`  -> assigned ${spec.fmsRole} @ ${spec.nodeName}`);

    credentials.push({ key: spec.key, email: spec.email, password, role: spec.role, node: spec.nodeName, fmsRole: spec.fmsRole });
  }

  console.log("\n=== Credentials (save these — shown once) ===");
  for (const c of credentials) {
    console.log(`${c.key.padEnd(14)} ${c.email.padEnd(32)} ${c.password.padEnd(16)} role=${c.role} fmsRole=${c.fmsRole}@${c.node}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
