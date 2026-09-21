import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { UserRole } from "../models/User";

/**
 * Only the access token is a JWT. The refresh token is an opaque
 * crypto.randomBytes value, hashed and stored in the RefreshToken
 * collection (see utils/refreshToken.ts) so it can be looked up, rotated,
 * and revoked — something a self-contained JWT can't do on its own.
 */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  tokenVersion: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}
