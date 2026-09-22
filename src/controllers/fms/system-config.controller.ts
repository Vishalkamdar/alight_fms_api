import { Response } from "express";
import { AppError } from "../../utils/AppError";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as systemConfigService from "../../services/fms/system-config.service";
import { uploadLogo } from "../../utils/fms/upload";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { UpdateSystemConfigInput } from "../../schemas/fms/system-config.schema";

/** Public — the login page and every other client need branding before authenticating. */
export async function getSystemConfig(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = await systemConfigService.getOrCreateConfig();
  sendSuccess(res, config);
}

export async function updateSystemConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as UpdateSystemConfigInput;
  const context = getActorContext(req);
  const config = await systemConfigService.updateConfig(body, context.actorId, context);
  sendSuccess(res, config, { message: "System configuration updated." });
}

export async function uploadSystemLogo(req: AuthenticatedRequest, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    uploadLogo(req, res, (err: unknown) => {
      if (err) {
        reject(new AppError(400, err instanceof Error ? err.message : "Failed to upload logo."));
        return;
      }
      resolve();
    });
  });

  if (!req.file) {
    throw new AppError(400, "A logo file is required.");
  }

  const context = getActorContext(req);
  const config = await systemConfigService.replaceLogo(req.file.filename, context.actorId, context);
  sendSuccess(res, config, { message: "Logo updated successfully." });
}
