import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  createNodeRoleConfigSchema,
  updateNodeRoleConfigSchema,
  nodeRoleConfigListQuerySchema,
  nodeIdRouteParamsSchema,
} from "../../schemas/fms/node-role-config.schema";
import * as controller from "../../controllers/fms/node-role-config.controller";

const router = Router();

router.use(authenticate);

// Only Super Admin may create/modify which FMS roles are usable on a node.
router.post(
  "/",
  authorizeRoles("Super Admin"),
  validate(createNodeRoleConfigSchema, "body"),
  controller.createNodeRoleConfig
);
router.put(
  "/:nodeId",
  authorizeRoles("Super Admin"),
  validate(nodeIdRouteParamsSchema, "params"),
  validate(updateNodeRoleConfigSchema, "body"),
  controller.updateNodeRoleConfig
);

// Admin needs read access to know what roles are assignable where.
router.get(
  "/",
  authorizeRoles("Super Admin", "Admin"),
  validate(nodeRoleConfigListQuerySchema, "query"),
  controller.listNodeRoleConfigs
);
router.get(
  "/:nodeId",
  authorizeRoles("Super Admin", "Admin"),
  validate(nodeIdRouteParamsSchema, "params"),
  controller.getNodeRoleConfig
);

export default router;
