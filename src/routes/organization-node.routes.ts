import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { objectIdParamsSchema } from "../schemas/common.schema";
import {
  createOrganizationNodeSchema,
  moveOrganizationNodeSchema,
  organizationNodeExportQuerySchema,
  organizationNodeListQuerySchema,
  reorderOrganizationNodeSchema,
  updateOrganizationNodeSchema,
  updateOrganizationNodeStatusSchema,
} from "../schemas/organization-node.schema";
import {
  bulkImportOrganizationNodes,
  createOrganizationNode,
  deleteOrganizationNode,
  exportOrganizationNodes,
  getOrganizationNode,
  getOrganizationTree,
  listOrganizationNodes,
  moveOrganizationNode,
  reorderOrganizationNode,
  updateOrganizationNode,
  updateOrganizationNodeStatus,
} from "../controllers/organization-node.controller";

const router = Router();

router.use(authenticate);

// Writing the hierarchy (Master Setup > Organization Nodes) is Super
// Admin-only. Admin keeps read access because the Organization Tree menu
// item and every Budget Management node picker depend on it; FMS
// Operational User has no access to either, so it's excluded from read too.
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin");

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get("/tree", canRead, getOrganizationTree);
router.post("/bulk-import", canWrite, bulkImportOrganizationNodes);
router.get(
  "/export",
  canRead,
  validate(organizationNodeExportQuerySchema, "query"),
  exportOrganizationNodes
);

router.get("/", canRead, validate(organizationNodeListQuerySchema, "query"), listOrganizationNodes);
router.post("/", canWrite, validate(createOrganizationNodeSchema, "body"), createOrganizationNode);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), getOrganizationNode);
router.put(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateOrganizationNodeSchema, "body"),
  updateOrganizationNode
);
router.patch(
  "/:id/status",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateOrganizationNodeStatusSchema, "body"),
  updateOrganizationNodeStatus
);
router.patch(
  "/:id/move",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(moveOrganizationNodeSchema, "body"),
  moveOrganizationNode
);
router.patch(
  "/:id/reorder",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(reorderOrganizationNodeSchema, "body"),
  reorderOrganizationNode
);
router.delete("/:id", canWrite, validate(objectIdParamsSchema, "params"), deleteOrganizationNode);

export default router;
