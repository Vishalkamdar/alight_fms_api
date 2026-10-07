import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { dashboardQuerySchema } from "../../schemas/fms/dashboard.schema";
import * as controller from "../../controllers/fms/dashboard.controller";

const router = Router();

router.use(authenticate);

// One Dashboard for every FMS role — the backend scopes the DATA (per actor's
// assigned Organization Node(s) and FMS role), not the route.
router.get(
  "/",
  authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker", "FMS Operational User - Verifier", "FMS Operational User - Checker"),
  validate(dashboardQuerySchema, "query"),
  controller.getDashboard
);

export default router;
