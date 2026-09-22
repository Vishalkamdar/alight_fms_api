import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { updateConfigurationSchema } from "../../schemas/fms/configuration.schema";
import * as controller from "../../controllers/fms/configuration.controller";

const router = Router();

// Public — the login page must know which login method (Email+Password vs
// SMS OTP) to render before the user is authenticated, same reasoning as
// system-config.routes.ts's public branding endpoint. Nothing sensitive
// lives here; OTP provider credentials are a separate, Super Admin-only
// model (see otp-provider.routes.ts).
router.get("/", controller.getConfiguration);

router.put(
  "/",
  authenticate,
  authorizeRoles("Super Admin"),
  validate(updateConfigurationSchema, "body"),
  controller.updateConfiguration
);

export default router;
