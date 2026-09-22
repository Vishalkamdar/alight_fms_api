import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(5000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required."),

  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required."),
  JWT_ACCESS_EXPIRES_IN: z.string().default("30m"),

  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required."),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),

  CLIENT_URL: z.string().default("http://localhost:3000"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("Alight FMS <no-reply@alight-fms.local>"),

  FMS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "FMS_ENCRYPTION_KEY must be a 32-byte (64 hex character) key.")
    .describe("AES-256-GCM key used to encrypt OTP provider credentials at rest."),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  smtpConfigured: Boolean(
    parsed.data.SMTP_HOST && parsed.data.SMTP_PORT && parsed.data.SMTP_USER && parsed.data.SMTP_PASSWORD
  ),
};
