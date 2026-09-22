import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { activityLogListQuerySchema } from "../schemas/activity-log.schema";
import { listActivityLogs } from "../controllers/activity-log.controller";

const router = Router();

// Security logs — Super Admin only.
router.use(authenticate, authorizeRoles("Super Admin"));

router.get("/", validate(activityLogListQuerySchema, "query"), listActivityLogs);

export default router;
