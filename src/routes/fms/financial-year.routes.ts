import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authorizeRoles } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { objectIdParamsSchema } from "../../schemas/common.schema";
import {
  closeBooksSchema,
  createFinancialYearSchema,
  enablePreviousYearEntrySchema,
  financialYearListQuerySchema,
  reopenFinancialYearSchema,
  updateFinancialYearSchema,
  updateFinancialYearStatusSchema,
} from "../../schemas/fms/financial-year.schema";
import * as controller from "../../controllers/fms/financial-year.controller";

const router = Router();

router.use(authenticate);

// Master Setup / hierarchy configuration is Super Admin-only; Admin gets
// read-only access, matching every other Master Setup master.
const canRead = authorizeRoles("Super Admin", "Admin");
const canWrite = authorizeRoles("Super Admin");

// Must be registered before "/:id" so "current" isn't captured as an id.
router.get("/current", canRead, controller.getCurrentFinancialYear);

router.get("/", canRead, validate(financialYearListQuerySchema, "query"), controller.listFinancialYears);
router.post(
  "/",
  canWrite,
  validate(createFinancialYearSchema, "body"),
  controller.createFinancialYear
);
router.get("/:id", canRead, validate(objectIdParamsSchema, "params"), controller.getFinancialYear);
router.put(
  "/:id",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateFinancialYearSchema, "body"),
  controller.updateFinancialYear
);
router.patch(
  "/:id/status",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(updateFinancialYearStatusSchema, "body"),
  controller.updateFinancialYearStatus
);
router.post(
  "/:id/enable-previous-year-entry",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(enablePreviousYearEntrySchema, "body"),
  controller.enablePreviousYearEntry
);
router.post(
  "/:id/close-books",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(closeBooksSchema, "body"),
  controller.closeBooks
);
router.post(
  "/:id/reopen",
  canWrite,
  validate(objectIdParamsSchema, "params"),
  validate(reopenFinancialYearSchema, "body"),
  controller.reopenFinancialYear
);
router.get(
  "/:id/closing-summary",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getClosingSummary
);
router.get(
  "/:id/department-summary",
  canRead,
  validate(objectIdParamsSchema, "params"),
  controller.getDepartmentSummary
);

export default router;
