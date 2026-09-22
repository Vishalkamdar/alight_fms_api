import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createSchemeHeadNodeSchema,
  schemeHeadNodeListQuerySchema,
  updateSchemeHeadNodeSchema,
  updateSchemeHeadNodeStatusSchema,
} from "../../schemas/fms/scheme-head-node.schema";
import * as controller from "../../controllers/fms/scheme-head-node.controller";

const router = Router();

router.use(authenticate);

// Only Super Admin manages the Scheme/Head Node master; Admin gets
// read-only access to view the financial hierarchy.
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin");

// Must be registered before "/:id" so "tree" isn't captured as an id.
router.get("/tree", canRead, controller.getSchemeHeadTree);

router.get(
  "/",
  canRead,
  validate(schemeHeadNodeListQuerySchema, "query"),
  controller.listSchemeHeadNodes
);
router.post(
  "/",
  canWrite,
  validate(createSchemeHeadNodeSchema, "body"),
  controller.createSchemeHeadNode
);
router.get(
  "/:id",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getSchemeHeadNode
);
router.put(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateSchemeHeadNodeSchema, "body"),
  controller.updateSchemeHeadNode
);
router.patch(
  "/:id/status",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateSchemeHeadNodeStatusSchema, "body"),
  controller.updateSchemeHeadNodeStatus
);
router.delete(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  controller.deleteSchemeHeadNode
);
router.get(
  "/:id/children",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getSchemeHeadChildren
);
router.get(
  "/:id/ancestors",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getSchemeHeadAncestors
);

export default router;
