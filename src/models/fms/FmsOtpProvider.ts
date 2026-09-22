import { Schema, model, Document, Types } from "mongoose";

/**
 * Fields that are always encrypted at rest when present, and never returned
 * verbatim by GET endpoints — see services/fms/otp-provider.service.ts.
 */
export const SENSITIVE_CONFIG_KEYS = ["apiKey", "apiSecret", "authToken", "password"] as const;

/**
 * A configured SMS/OTP gateway. Deliberately provider-agnostic — every
 * provider-specific parameter (API URL, credentials, sender ID, request
 * template, ...) lives in the free-form `configuration` object rather than
 * being hardcoded as schema fields, per spec: "do not hardcode the database
 * schema around one provider."
 */
export interface FmsOtpProviderDocument extends Document {
  _id: Types.ObjectId;
  providerName: string;
  providerCode: string;
  priority: number;
  isEnabled: boolean;
  configuration: Record<string, unknown>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const fmsOtpProviderSchema = new Schema<FmsOtpProviderDocument>(
  {
    providerName: { type: String, required: true, trim: true, maxlength: 100 },
    providerCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: 40,
    },
    priority: { type: Number, required: true, default: 1, min: 1 },
    isEnabled: { type: Boolean, default: true },
    configuration: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

fmsOtpProviderSchema.index({ priority: 1, isEnabled: 1 });

export const FmsOtpProviderModel = model<FmsOtpProviderDocument>(
  "FmsOtpProvider",
  fmsOtpProviderSchema
);
