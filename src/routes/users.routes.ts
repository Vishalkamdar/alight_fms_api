import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { objectIdParamsSchema } from "../schemas/common.schema";
import {
  createUserSchema,
  updateUserSchema,
  updateUserStatusSchema,
  userListQuerySchema,
} from "../schemas/fms/user.schema";
import * as controller from "../controllers/fms/user.controller";

const router = Router();

router.use(authenticate);

// Manage Users is Super Admin + Admin only — FMS Operational User has no
// access to this menu at all.
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin", "Admin");

router.get("/", canRead, validate(userListQuerySchema, "query"), controller.listUsers);
router.post("/", canWrite, validate(createUserSchema, "body"), controller.createUser);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), controller.getUser);
router.put(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateUserSchema, "body"),
  controller.updateUser
);
router.patch(
  "/:id/status",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateUserStatusSchema, "body"),
  controller.updateUserStatus
);

export default router;
