import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createOtpProviderSchema,
  otpProviderListQuerySchema,
  updateOtpProviderSchema,
  updateOtpProviderStatusSchema,
} from "../../schemas/fms/otp-provider.schema";
import * as controller from "../../controllers/fms/otp-provider.controller";

const router = Router();

// Only Super Admin may see or manage OTP providers — configuration.routes.ts
// exposes the read-only "which login method is active" bit to Admin, but
// provider credentials (even masked) stay Super Admin-only.
router.use(authenticate, authorizeRoles("Super Admin"));

router.get("/", validate(otpProviderListQuerySchema, "query"), controller.listOtpProviders);
router.post("/", validate(createOtpProviderSchema, "body"), controller.createOtpProvider);
router.get("/:id", validate(objectIdParamsSchema, "params"), controller.getOtpProvider);
router.put(
  "/:id",
  validate(objectIdParamsSchema, "params"),
  validate(updateOtpProviderSchema, "body"),
  controller.updateOtpProvider
);
router.patch(
  "/:id/status",
  validate(objectIdParamsSchema, "params"),
  validate(updateOtpProviderStatusSchema, "body"),
  controller.updateOtpProviderStatus
);
router.delete("/:id", validate(objectIdParamsSchema, "params"), controller.deleteOtpProvider);

export default router;
