import { Schema, model, Document, Types } from "mongoose";

/**
 * LOGIN: pre-authentication, mobile-number-based login.
 * VERIFIER_ACTION / CHECKER_ACTION: gates a specific workflow action once
 * future transaction modules (Invoice, Payroll, ...) call the OTP service.
 * An OTP issued for one purpose can never satisfy another — see
 * services/otp.service.ts#validateOtp.
 */
export const OTP_PURPOSES = ["LOGIN", "VERIFIER_ACTION", "CHECKER_ACTION"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * Context binding an action-purpose OTP to the exact transaction it
 * authorizes — required so a Verifier/Checker OTP can't be replayed against
 * a different transaction or action. Left empty for LOGIN-purpose OTPs.
 */
export interface OtpActionContext {
  action?: string;
  transactionId?: string;
  nodeId?: string;
}

/**
 * A single OTP challenge. Never stores the OTP in plain text — only its
 * hash. Rows are short-lived by design: a TTL index purges them shortly
 * after expiry regardless of whether they were ever consumed, since an OTP
 * is an ephemeral secret, not an audit record (compare UserActivityLog,
 * which is append-only and never auto-purged).
 */
export interface FmsOtpDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId | null;
  mobileNumber: string;
  purpose: OtpPurpose;
  otpHash: string;
  context: OtpActionContext;
  attempts: number;
  maxAttempts: number;
  consumed: boolean;
  consumedAt: Date | null;
  providerUsed: string | null;
  expiresAt: Date;
  purgeAt: Date;
  createdAt: Date;
}

const otpActionContextSchema = new Schema<OtpActionContext>(
  {
    action: { type: String, default: undefined },
    transactionId: { type: String, default: undefined },
    nodeId: { type: String, default: undefined },
  },
  { _id: false }
);

const fmsOtpSchema = new Schema<FmsOtpDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    mobileNumber: { type: String, required: true, trim: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    otpHash: { type: String, required: true, select: false },
    context: { type: otpActionContextSchema, default: {} },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    consumed: { type: Boolean, default: false },
    consumedAt: { type: Date, default: null },
    providerUsed: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    // Purged automatically 1 hour after expiry — plenty of time for
    // debugging a failed send without keeping ephemeral secrets around.
    purgeAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

fmsOtpSchema.index({ user: 1, purpose: 1, consumed: 1 });
fmsOtpSchema.index({ mobileNumber: 1, purpose: 1, consumed: 1 });
fmsOtpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const FmsOtpModel = model<FmsOtpDocument>("FmsOtp", fmsOtpSchema);
