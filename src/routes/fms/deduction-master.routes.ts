import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  createDeductionMasterSchema,
  deductionMasterExportQuerySchema,
  deductionMasterListQuerySchema,
  setDeductionMasterActiveSchema,
  updateDeductionMasterSchema,
} from "../../schemas/fms/deduction-master.schema";
import * as controller from "../../controllers/fms/deduction-master.controller";

const router = Router();

router.use(authenticate);

// Managing the master (create/update/export/active-toggle/delete) is Super
// Admin only. Reading it is wider — §14's own intent is that Admin/Maker
// consume active deductions through their Expenditure/Payment screens,
// which call this same list/detail endpoint for their dropdown options, so
// they need read access here too; only mutation stays Super Admin only.
const canManage = authorizeRoles("Super Admin");
const canRead = authorizeRoles("Super Admin", "Admin", "FMS Operational User - Maker");

// Must be registered before "/:id" so this static segment isn't captured as an id.
router.get("/export", canManage, validate(deductionMasterExportQuerySchema, "query"), controller.exportDeductionMasters);

router.get("/", canRead, validate(deductionMasterListQuerySchema, "query"), controller.listDeductionMasters);
router.post("/", canManage, validate(createDeductionMasterSchema, "body"), controller.createDeductionMaster);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), controller.getDeductionMaster);
router.put(
  "/:id",
  canManage,
  validate(objectIdParamsSchema, "params"),
  validate(updateDeductionMasterSchema, "body"),
  controller.updateDeductionMaster
);
router.patch(
  "/:id/active",
  canManage,
  validate(objectIdParamsSchema, "params"),
  validate(setDeductionMasterActiveSchema, "body"),
  controller.setDeductionMasterActive
);
router.delete("/:id", canManage, validate(objectIdParamsSchema, "params"), controller.deleteDeductionMaster);

export default router;
