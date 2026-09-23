import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { activityLogListQuerySchema } from "../schemas/activity-log.schema";
import { listActivityLogs } from "../controllers/activity-log.controller";

const router = Router();

// Security logs — Super Admin and Admin (not Master Setup; Admin keeps this
// per the FMS menu access matrix).
router.use(authenticate, authorizeRoles("Super Admin", "Admin"));

router.get("/", validate(activityLogListQuerySchema, "query"), listActivityLogs);

export default router;
