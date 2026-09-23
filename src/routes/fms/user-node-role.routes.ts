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

// Assigning Maker/Verifier/Checker node roles is part of Approval Roles, a
// Master Setup submenu — Super Admin only.
const canManageAssignments = authorizeRoles("Super Admin");

router.post(
  "/user-node-roles",
  canManageAssignments,
  validate(createUserNodeRoleSchema, "body"),
  controller.createUserNodeRole
);
router.get(
  "/user-node-roles",
  canManageAssignments,
  validate(userNodeRoleListQuerySchema, "query"),
  controller.listUserNodeRoles
);
router.get(
  "/user-node-roles/:id",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  controller.getUserNodeRoleById
);
router.put(
  "/user-node-roles/:id",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  validate(updateUserNodeRoleSchema, "body"),
  controller.updateUserNodeRole
);
router.patch(
  "/user-node-roles/:id/status",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  validate(updateAssignmentStatusSchema, "body"),
  controller.updateUserNodeRoleStatus
);
router.delete(
  "/user-node-roles/:id",
  canManageAssignments,
  validate(objectIdParamsSchema, "params"),
  controller.deleteUserNodeRole
);

router.get(
  "/users/:userId/nodes",
  canManageAssignments,
  validate(userIdParamsSchema, "params"),
  controller.getUserNodes
);
router.get(
  "/nodes/:nodeId/users",
  canManageAssignments,
  validate(nodeIdParamsSchema, "params"),
  validate(nodeUsersQuerySchema, "query"),
  controller.getNodeUsers
);

export default router;
