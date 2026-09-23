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

// Approval Roles is a Master Setup submenu — Super Admin only end to end,
// read included (its only consumer is the Master Setup > Approval Roles page).
const canRead = authorizeRoles("Super Admin");

router.get("/", canRead, validate(nodeRoleConfigListQuerySchema, "query"), controller.listNodeRoleConfigs);
router.get(
  "/:nodeId",
  canRead,
  validate(nodeIdRouteParamsSchema, "params"),
  controller.getNodeRoleConfig
);

export default router;
