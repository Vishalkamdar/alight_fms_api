import { Schema, model, Document, Types } from "mongoose";

export const LOGIN_AUTH_METHODS = ["EMAIL_PASSWORD", "SMS_OTP"] as const;
export type LoginAuthMethod = (typeof LOGIN_AUTH_METHODS)[number];

export interface OtpSettings {
  length: number;
  expiryMinutes: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  maxResendAttempts: number;
}

/**
 * Single global FMS behavior-configuration document — always accessed via
 * the fixed `key: "system"` unique value, same singleton pattern as
 * FmsSystemConfig (branding). This one governs authentication and workflow
 * behavior rather than branding.
 */
export interface FmsConfigurationDocument extends Document {
  _id: Types.ObjectId;
  key: "system";
  loginAuthenticationMethod: LoginAuthMethod;
  verifierCheckerSmsAuthentication: boolean;
  allocationRequireHead: boolean;
  otpSettings: OtpSettings;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const otpSettingsSchema = new Schema<OtpSettings>(
  {
    length: { type: Number, required: true, default: 6, min: 4, max: 10 },
    expiryMinutes: { type: Number, required: true, default: 5, min: 1, max: 60 },
    maxAttempts: { type: Number, required: true, default: 5, min: 1, max: 20 },
    resendCooldownSeconds: { type: Number, required: true, default: 30, min: 0, max: 600 },
    maxResendAttempts: { type: Number, required: true, default: 5, min: 1, max: 20 },
  },
  { _id: false }
);

const fmsConfigurationSchema = new Schema<FmsConfigurationDocument>(
  {
    key: { type: String, enum: ["system"], default: "system", unique: true },
    loginAuthenticationMethod: {
      type: String,
      enum: LOGIN_AUTH_METHODS,
      default: "EMAIL_PASSWORD",
    },
    verifierCheckerSmsAuthentication: { type: Boolean, default: false },
    allocationRequireHead: { type: Boolean, default: false },
    otpSettings: { type: otpSettingsSchema, default: () => ({}) },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const FmsConfigurationModel = model<FmsConfigurationDocument>(
  "FmsConfiguration",
  fmsConfigurationSchema
);
