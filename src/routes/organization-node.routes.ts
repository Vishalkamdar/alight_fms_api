import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { validate } from "../middleware/validate";
import { objectIdParamsSchema } from "../schemas/common.schema";
import {
  createOrganizationNodeSchema,
  moveOrganizationNodeSchema,
  organizationNodeListQuerySchema,
  reorderOrganizationNodeSchema,
  updateOrganizationNodeSchema,
  updateOrganizationNodeStatusSchema,
} from "../schemas/organization-node.schema";
import {
  bulkImportOrganizationNodes,
  createOrganizationNode,
  deleteOrganizationNode,
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

// Master Setup / hierarchy configuration is Super Admin-only; Admin and FMS
// Operational Roles Manager get read-only access so they can pick nodes
// while assigning users to Maker/Verifier/Checker roles.
const canRead = authorizeRoles("Super Admin", "Admin", "FMS Operational Roles Manager");
const canWrite = authorizeRoles("Super Admin");

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get("/tree", canRead, getOrganizationTree);
router.post("/bulk-import", canWrite, bulkImportOrganizationNodes);

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
