import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  beneficiaryExportQuerySchema,
  beneficiaryListQuerySchema,
  createBeneficiarySchema,
  setBeneficiaryActiveSchema,
  updateBeneficiarySchema,
} from "../../schemas/fms/beneficiary.schema";
import * as controller from "../../controllers/fms/beneficiary.controller";

const router = Router();

router.use(authenticate);

// Master data used later by Payments/salary transactions — managed by
// Super Admin and Admin only, same tier as Manage Users and Master Setup.
const canManage = authorizeRoles("Super Admin", "Admin");

// Must be registered before "/:id" so these static segments aren't captured as an id.
router.get("/export", canManage, validate(beneficiaryExportQuerySchema, "query"), controller.exportBeneficiaries);
router.post("/vendors/bulk-import", canManage, controller.bulkImportVendors);
router.post("/employees/bulk-import", canManage, controller.bulkImportEmployees);

router.get("/", canManage, validate(beneficiaryListQuerySchema, "query"), controller.listBeneficiaries);
router.post("/", canManage, validate(createBeneficiarySchema, "body"), controller.createBeneficiary);
router.get("/:id", canManage, validate(objectIdParamsSchema, "params"), controller.getBeneficiary);
router.put(
  "/:id",
  canManage,
  validate(objectIdParamsSchema, "params"),
  validate(updateBeneficiarySchema, "body"),
  controller.updateBeneficiary
);
router.patch(
  "/:id/active",
  canManage,
  validate(objectIdParamsSchema, "params"),
  validate(setBeneficiaryActiveSchema, "body"),
  controller.setBeneficiaryActive
);
router.delete("/:id", canManage, validate(objectIdParamsSchema, "params"), controller.deleteBeneficiary);

export default router;
