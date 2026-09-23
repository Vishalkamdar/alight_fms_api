import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import * as controller from "../../controllers/fms/approvals.controller";

const router = Router();

router.use(authenticate);

// Every app role that can reach the Approvals menu gets this — the actual
// filtering to "records I hold an active Verifier/Checker assignment for"
// happens inside the service, so a user with no such assignment on any node
// simply sees an empty list.
router.get(
  "/my-pending",
  authorizeRoles("Super Admin", "Admin", "FMS Operational User"),
  controller.getMyPendingApprovals
);

export default router;
