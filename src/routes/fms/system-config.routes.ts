import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { updateSystemConfigSchema } from "../../schemas/fms/system-config.schema";
import * as controller from "../../controllers/fms/system-config.controller";

const router = Router();

// Public: the login page and every client need branding before authenticating.
router.get("/", controller.getSystemConfig);

router.put(
  "/",
  authenticate,
  authorizeRoles("Super Admin"),
  validate(updateSystemConfigSchema, "body"),
  controller.updateSystemConfig
);

router.post("/logo", authenticate, authorizeRoles("Super Admin"), controller.uploadSystemLogo);

export default router;
