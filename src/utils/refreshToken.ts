import { Types } from "mongoose";
import { env } from "../config/env";
import { parseDurationToSeconds } from "./duration";
import { generateOpaqueToken, hmacSha256 } from "./hash";
import { RefreshTokenModel, RefreshTokenDocument } from "../models/RefreshToken";

interface IssueContext {
  userId: Types.ObjectId | string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

interface IssuedRefreshToken {
  rawToken: string;
  document: RefreshTokenDocument;
}

export function hashRefreshToken(rawToken: string): string {
  return hmacSha256(env.JWT_REFRESH_SECRET, rawToken);
}

export async function issueRefreshToken(context: IssueContext): Promise<IssuedRefreshToken> {
  const rawToken = generateOpaqueToken();
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = new Date(
    Date.now() + parseDurationToSeconds(env.JWT_REFRESH_EXPIRES_IN) * 1000
  );

  const document = await RefreshTokenModel.create({
    user: context.userId,
    tokenHash,
    expiresAt,
    userAgent: context.userAgent ?? null,
    ipAddress: context.ipAddress ?? null,
  });

  return { rawToken, document };
}

/** Returns the token document only if it exists, is unrevoked, and unexpired. */
export async function findActiveRefreshToken(
  rawToken: string
): Promise<RefreshTokenDocument | null> {
  const tokenHash = hashRefreshToken(rawToken);
  const doc = await RefreshTokenModel.findOne({ tokenHash });

  if (!doc) return null;
  if (doc.isRevoked) return null;
  if (doc.expiresAt.getTime() <= Date.now()) return null;

  return doc;
}

export async function revokeRefreshToken(
  document: RefreshTokenDocument,
  replacedByTokenId?: Types.ObjectId
): Promise<void> {
  document.isRevoked = true;
  document.revokedAt = new Date();
  if (replacedByTokenId) document.replacedByToken = replacedByTokenId;
  await document.save();
}

export async function revokeAllRefreshTokensForUser(
  userId: Types.ObjectId | string
): Promise<void> {
  await RefreshTokenModel.updateMany(
    { user: userId, isRevoked: false },
    { $set: { isRevoked: true, revokedAt: new Date() } }
  );
}
