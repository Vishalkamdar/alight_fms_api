import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as otpProviderService from "../../services/fms/otp-provider.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type {
  CreateOtpProviderInput,
  OtpProviderListQuery,
  UpdateOtpProviderInput,
} from "../../schemas/fms/otp-provider.schema";

export async function listOtpProviders(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = res.locals.query as OtpProviderListQuery;
  const { items, meta } = await otpProviderService.listProviders(query);
  sendSuccess(res, items, { meta, message: "OTP providers retrieved successfully." });
}

export async function getOtpProvider(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const provider = await otpProviderService.getProviderById(id);
  sendSuccess(res, provider);
}

export async function createOtpProvider(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as CreateOtpProviderInput;
  const context = getActorContext(req);
  const provider = await otpProviderService.createProvider(body, context);
  sendSuccess(res, provider, { statusCode: 201, message: "OTP provider created." });
}

export async function updateOtpProvider(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const body = res.locals.body as UpdateOtpProviderInput;
  const context = getActorContext(req);
  const provider = await otpProviderService.updateProvider(id, body, context);
  sendSuccess(res, provider, { message: "OTP provider updated." });
}

export async function updateOtpProviderStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const { isEnabled } = res.locals.body as { isEnabled: boolean };
  const context = getActorContext(req);
  const provider = await otpProviderService.updateProviderStatus(id, isEnabled, context);
  sendSuccess(res, provider, { message: `OTP provider ${isEnabled ? "enabled" : "disabled"}.` });
}

export async function deleteOtpProvider(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = res.locals.params as { id: string };
  const context = getActorContext(req);
  await otpProviderService.deleteProvider(id, context);
  sendSuccess(res, null, { message: "OTP provider deleted." });
}
