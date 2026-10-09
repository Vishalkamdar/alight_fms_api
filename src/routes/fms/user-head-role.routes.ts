import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createUserHeadRoleSchema,
  updateAssignmentStatusSchema,
  userHeadRoleListQuerySchema,
  userIdParamsSchema,
} from "../../schemas/fms/user-head-role.schema";
import * as controller from "../../controllers/fms/user-head-role.controller";

const router = Router();

router.use(authenticate);

// Self-service: any authenticated user may inspect their own Head access.
router.get("/my-heads", controller.getMyHeads);

// Assigning users to Heads — mirrors Approval Roles' node assignment,
// Super Admin only.
const canManageAssignments = authorizeRoles("Super Admin");

router.post(
  "/user-head-roles",
  canManageAssignments,
  validate(createUserHeadRoleSchema, "body"),
  controller.createUserHeadRole
);
router.get(
  "/user-head-roles",
  canManageAssignments,
  validate(userHeadRoleListQuerySchema, "query"),
  controller.listUserHeadRoles
);
router.get(
  "/user-head-roles/:id",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  controller.getUserHeadRoleById
);
router.patch(
  "/user-head-roles/:id/status",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  validate(updateAssignmentStatusSchema, "body"),
  controller.updateUserHeadRoleStatus
);
router.delete(
  "/user-head-roles/:id",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  controller.deleteUserHeadRole
);

router.get(
  "/users/:userId/heads",
  canManageAssignments,
  validate(userIdParamsSchema, "params"),
  controller.getUserHeads
);

export default router;
