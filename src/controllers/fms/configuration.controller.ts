import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContext } from "../../utils/requestContext";
import * as configurationService from "../../services/fms/configuration.service";
import type { AuthenticatedRequest } from "../../middleware/auth";
import type { UpdateConfigurationInput } from "../../schemas/fms/configuration.schema";

export async function getConfiguration(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = await configurationService.getOrCreateConfiguration();
  sendSuccess(res, config);
}

export async function updateConfiguration(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = res.locals.body as UpdateConfigurationInput;
  const context = getActorContext(req);
  const config = await configurationService.updateConfiguration(body, context.actorId, context);
  sendSuccess(res, config, { message: "Configuration updated." });
}
