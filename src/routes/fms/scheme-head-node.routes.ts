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
import { getMyAllocatableHeads } from "../../controllers/fms/user-head-role.controller";

const router = Router();

router.use(authenticate);

// Only Super Admin manages the Scheme/Head Node master; Admin, Maker,
// Verifier, and Checker get read-only access to view the financial
// hierarchy — a Maker needs it to pick a Head when creating a Budget
// Allocation, and Verifier/Checker need it for the Scheme/Head filter on
// their approval queues.
const canRead = authorizeRoles(
  "Super Admin",
  "Admin",
  "FMS Operational User - Maker",
  "FMS Operational User - Verifier",
  "FMS Operational User - Checker"
);
const canWrite = authorizeRoles("Super Admin");

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get("/tree", canRead, controller.getSchemeHeadTree);
// The authorization-backed, descendant-expanded shape the Dashboard/Reports
// Head filter picker consumes — never the full unscoped tree above, for a
// Head-restricted caller (mirrors budget-allocations/my-allocatable-nodes).
router.get("/my-allocatable-heads", canRead, getMyAllocatableHeads);

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
