import { Schema, model, Document, Types } from "mongoose";

export interface RefreshTokenDocument extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  isRevoked: boolean;
  revokedAt: Date | null;
  replacedByToken: Types.ObjectId | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    isRevoked: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
    replacedByToken: { type: Schema.Types.ObjectId, ref: "RefreshToken", default: null },
    userAgent: { type: String, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Auto-purges expired refresh tokens instead of letting the collection grow forever.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model<RefreshTokenDocument>("RefreshToken", refreshTokenSchema);
