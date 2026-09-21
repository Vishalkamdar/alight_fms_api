import crypto from "crypto";

/** High-entropy opaque token (hex-encoded), used for refresh tokens and password reset tokens. */
export function generateOpaqueToken(bytes = 40): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Unkeyed hash for single-use, short-lived tokens (e.g. password reset). */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Keyed hash for longer-lived, DB-verified tokens (e.g. refresh tokens). */
export function hmacSha256(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
