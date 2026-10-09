import { Schema, model, Document, Types } from "mongoose";

/**
 * Application-level roles. The three "FMS Operational User - X" roles are
 * restricted, mutually exclusive tiers — each gets exactly one menu and one
 * workflow action, never a combination:
 *   - Maker: Budget Management only (create/edit entries pre-verification).
 *   - Verifier: Approvals only, and only the "verify" action.
 *   - Checker: Approvals only, and only the "approve" (final) action.
 * None of the three has Master Setup, Manage Users, or any other menu
 * access. A user's FmsUserNodeRole assignments (models/fms/FmsUserNodeRole)
 * still carry WHICH Organization Node(s) they can act on — this system role
 * only fixes WHICH of Maker/Verifier/Checker they're allowed to be assigned
 * as (see user-node-role.service.ts's role-match check on assignment). See
 * the per-route authorizeRoles() calls across src/routes for exactly what
 * each role can reach, and constants/fms/nav.ts (frontend) for the matching
 * menu visibility rules.
 */
export const USER_ROLES = [
  "Super Admin",
  "Admin",
  "FMS Operational User - Maker",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_USER_ROLE: UserRole = "Admin";

export interface UserDocument extends Document {
  _id: Types.ObjectId;
  fullname: string;
  email: string;
  password: string;
  countryCode: string;
  phone: string;
  role: UserRole;
  isActive: boolean;
  isEmailVerified: boolean;
  tokenVersion: number;
  passwordResetToken: string | null;
  passwordResetExpires: Date | null;
  lastLoginAt: Date | null;
  profilePhotoUrl: string | null;
  /** The not-yet-verified new email address a profile update is waiting to confirm — `user.email` itself is never touched until verified. */
  pendingEmail: string | null;
  pendingEmailToken: string | null;
  pendingEmailExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDocument>(
  {
    fullname: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    // select: false keeps this out of every query result unless explicitly requested.
    password: { type: String, required: true, select: false },
    countryCode: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    role: { type: String, enum: USER_ROLES, default: DEFAULT_USER_ROLE },
    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    passwordResetToken: { type: String, default: null, select: false },
    passwordResetExpires: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    profilePhotoUrl: { type: String, default: null },
    pendingEmail: { type: String, default: null },
    pendingEmailToken: { type: String, default: null, select: false },
    pendingEmailExpires: { type: Date, default: null, select: false },
  },
  { timestamps: true }
);

export const UserModel = model<UserDocument>("User", userSchema);
