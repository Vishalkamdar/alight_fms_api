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

router.use(authenticate, authorizeRoles("Super Admin", "Admin"));

router.get("/", validate(userListQuerySchema, "query"), controller.listUsers);
router.post("/", validate(createUserSchema, "body"), controller.createUser);
router.get("/:id", validate(objectIdParamsSchema, "params"), controller.getUser);
router.put(
  "/:id",
  validate(objectIdParamsSchema, "params"),
  validate(updateUserSchema, "body"),
  controller.updateUser
);
router.patch(
  "/:id/status",
  validate(objectIdParamsSchema, "params"),
  validate(updateUserStatusSchema, "body"),
  controller.updateUserStatus
);

export default router;
