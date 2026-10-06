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

// Master Setup data — Super Admin only (§14: Admin/Operational Users
// consume active deductions only through their own permitted
// Expenditure/Payment screens, never through this master directly).
const canManage = authorizeRoles("Super Admin");

// Must be registered before "/:id" so this static segment isn't captured as an id.
router.get("/export", canManage, validate(deductionMasterExportQuerySchema, "query"), controller.exportDeductionMasters);

router.get("/", canManage, validate(deductionMasterListQuerySchema, "query"), controller.listDeductionMasters);
router.post("/", canManage, validate(createDeductionMasterSchema, "body"), controller.createDeductionMaster);
router.get("/:id", canManage, validate(objectIdParamsSchema, "params"), controller.getDeductionMaster);
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
