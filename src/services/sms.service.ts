import { FmsOtpProviderModel, SENSITIVE_CONFIG_KEYS, type FmsOtpProviderDocument } from "../models/fms/FmsOtpProvider";
import { decryptSecret } from "../utils/encryption";

interface SendResult {
  success: boolean;
  providerCode: string | null;
}

function fillTemplate(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return Object.entries(vars).reduce((text, [key, val]) => text.split(`{{${key}}}`).join(val), value);
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, fillTemplate(val, vars)])
    );
  }
  return value;
}

/**
 * Every provider-specific request shape (which fields, which auth header,
 * ...) is expressed in `configuration.requestBody`/`configuration.headers`
 * as a template, so no vendor's API shape is hardcoded here — per spec,
 * "do not hardcode a specific SMS provider."
 */
async function callProvider(
  provider: FmsOtpProviderDocument,
  mobileNumber: string,
  otpCode: string
): Promise<boolean> {
  const config = { ...(provider.configuration ?? {}) } as Record<string, unknown>;

  for (const key of SENSITIVE_CONFIG_KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.length > 0) {
      try {
        config[key] = decryptSecret(value);
      } catch {
        console.error(`[sms] provider ${provider.providerCode}: failed to decrypt "${key}".`);
        return false;
      }
    }
  }

  const apiUrl = config.apiUrl;
  if (!apiUrl || typeof apiUrl !== "string") {
    console.error(`[sms] provider ${provider.providerCode} has no apiUrl configured.`);
    return false;
  }

  const vars: Record<string, string> = { mobile: mobileNumber, otp: otpCode };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") vars[key] = value;
  }

  const bodyTemplate = config.requestBody ?? { mobile: mobileNumber, otp: otpCode };
  const body = fillTemplate(bodyTemplate, vars);
  const headerTemplate = config.headers && typeof config.headers === "object" ? config.headers : {};
  const headers = {
    "Content-Type": "application/json",
    ...(fillTemplate(headerTemplate, vars) as Record<string, string>),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(apiUrl, {
      method: typeof config.method === "string" ? config.method : "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[sms] provider ${provider.providerCode} responded with status ${response.status}.`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      `[sms] provider ${provider.providerCode} request failed:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Tries every enabled provider in priority order, falling back to the next
 * on failure. Falls back to a console log — never a real failure — when no
 * provider is configured at all, mirroring email.service.ts's SMTP
 * fallback, so auth flows keep working in dev without real SMS credentials.
 */
export async function sendSms(mobileNumber: string, otpCode: string): Promise<SendResult> {
  const providers = await FmsOtpProviderModel.find({ isEnabled: true }).sort({ priority: 1 });

  if (providers.length === 0) {
    console.log(`[sms] No OTP providers configured — logging instead of sending.\n  To: ${mobileNumber}\n  OTP: ${otpCode}`);
    return { success: true, providerCode: null };
  }

  for (const provider of providers) {
    const delivered = await callProvider(provider, mobileNumber, otpCode);
    if (delivered) return { success: true, providerCode: provider.providerCode };
    console.warn(`[sms] provider ${provider.providerCode} failed, trying next.`);
  }

  console.error(`[sms] All ${providers.length} OTP provider(s) failed to deliver to ${mobileNumber}.`);
  return { success: false, providerCode: null };
}
