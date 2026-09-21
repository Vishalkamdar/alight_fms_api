import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createUserNodeRoleSchema,
  updateUserNodeRoleSchema,
  updateAssignmentStatusSchema,
  userNodeRoleListQuerySchema,
  nodeUsersQuerySchema,
  userIdParamsSchema,
  nodeIdParamsSchema,
} from "../../schemas/fms/user-node-role.schema";
import * as controller from "../../controllers/fms/user-node-role.controller";

const router = Router();

router.use(authenticate);

// Self-service: any authenticated user may inspect their own node access.
router.get("/my-nodes", controller.getMyNodes);
router.get(
  "/my-nodes/:nodeId/role",
  validate(nodeIdParamsSchema, "params"),
  controller.getMyNodeRole
);

// Admin-managed FMS role assignments.
router.post(
  "/user-node-roles",
  authorizeRoles("Admin", "Super Admin"),
  validate(createUserNodeRoleSchema, "body"),
  controller.createUserNodeRole
);
router.get(
  "/user-node-roles",
  authorizeRoles("Admin", "Super Admin"),
  validate(userNodeRoleListQuerySchema, "query"),
  controller.listUserNodeRoles
);
router.get(
  "/user-node-roles/:id",
  authorizeRoles("Admin", "Super Admin"),
  validate(objectIdParamsSchema, "params"),
  controller.getUserNodeRoleById
);
router.put(
  "/user-node-roles/:id",
  authorizeRoles("Admin", "Super Admin"),
  validate(objectIdParamsSchema, "params"),
  validate(updateUserNodeRoleSchema, "body"),
  controller.updateUserNodeRole
);
router.patch(
  "/user-node-roles/:id/status",
  authorizeRoles("Admin", "Super Admin"),
  validate(objectIdParamsSchema, "params"),
  validate(updateAssignmentStatusSchema, "body"),
  controller.updateUserNodeRoleStatus
);
router.delete(
  "/user-node-roles/:id",
  authorizeRoles("Admin", "Super Admin"),
  validate(objectIdParamsSchema, "params"),
  controller.deleteUserNodeRole
);

router.get(
  "/users/:userId/nodes",
  authorizeRoles("Admin", "Super Admin"),
  validate(userIdParamsSchema, "params"),
  controller.getUserNodes
);
router.get(
  "/nodes/:nodeId/users",
  authorizeRoles("Admin", "Super Admin"),
  validate(nodeIdParamsSchema, "params"),
  validate(nodeUsersQuerySchema, "query"),
  controller.getNodeUsers
);

export default router;
