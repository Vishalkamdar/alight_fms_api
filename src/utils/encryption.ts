import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM
const key = Buffer.from(env.FMS_ENCRYPTION_KEY, "hex");

/**
 * AES-256-GCM encryption for values that must be stored encrypted at rest
 * (OTP provider API keys/secrets). Output is `iv:authTag:ciphertext`, all hex.
 */
export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, authTagHex, dataHex] = payload.split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Last 4 characters visible, everything else masked — for safe display in the UI. */
export function maskSecret(plainText: string): string {
  if (plainText.length <= 4) return "****";
  return `${"*".repeat(Math.max(plainText.length - 4, 4))}${plainText.slice(-4)}`;
}
