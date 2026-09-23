import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { objectIdParamsSchema } from "../schemas/common.schema";
import {
  createNodeTypeSchema,
  nodeTypeListQuerySchema,
  updateNodeTypeSchema,
  updateNodeTypeStatusSchema,
} from "../schemas/node-type.schema";
import {
  createNodeType,
  deleteNodeType,
  getNodeType,
  listNodeTypes,
  updateNodeType,
  updateNodeTypeStatus,
} from "../controllers/node-type.controller";

const router = Router();

router.use(authenticate);

// Node Types / Labels is a Master Setup submenu — Super Admin only, no
// exceptions (unlike Organization Nodes/Scheme-Head Nodes/Financial Years,
// nothing outside Master Setup reads this list).
router.get(
  "/",
  authorizeRoles("Super Admin"),
  validate(nodeTypeListQuerySchema, "query"),
  listNodeTypes
);
router.get(
  "/:id",
  authorizeRoles("Super Admin"),
  validate(objectIdParamsSchema, "params"),
  getNodeType
);

router.post("/", authorizeRoles("Super Admin"), validate(createNodeTypeSchema, "body"), createNodeType);
router.put(
  "/:id",
  authorizeRoles("Super Admin"),
  validate(objectIdParamsSchema, "params"),
  validate(updateNodeTypeSchema, "body"),
  updateNodeType
);
router.patch(
  "/:id/status",
  authorizeRoles("Super Admin"),
  validate(objectIdParamsSchema, "params"),
  validate(updateNodeTypeStatusSchema, "body"),
  updateNodeTypeStatus
);
router.delete(
  "/:id",
  authorizeRoles("Super Admin"),
  validate(objectIdParamsSchema, "params"),
  deleteNodeType
);

export default router;
