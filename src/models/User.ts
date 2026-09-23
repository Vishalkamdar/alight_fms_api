import { Schema, model, Document, Types } from "mongoose";

/**
 * Application-level roles only. FMS operational roles (Maker/Verifier/
 * Checker) are never stored here — see models/fms/FmsUserNodeRole.ts.
 *
 * "FMS Operational User" is a restricted third tier: it can access ONLY the
 * Approvals module, and even there only the transactions its assigned
 * Maker/Verifier/Checker node-role and Organization Node actually cover. It
 * has no Master Setup, Manage Users, Budget Management, or any other menu
 * access. See the per-route authorizeRoles() calls across src/routes for
 * exactly what each role can reach, and constants/fms/nav.ts (frontend) for
 * the matching menu visibility rules.
 */
export const USER_ROLES = ["Super Admin", "Admin", "FMS Operational User"] as const;
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
  },
  { timestamps: true }
);

export const UserModel = model<UserDocument>("User", userSchema);
