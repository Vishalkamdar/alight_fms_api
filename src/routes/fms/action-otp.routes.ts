import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { authRateLimiter } from "../../middleware/rateLimiter";
import { validate } from "../../middleware/validate";
import { requestActionOtpSchema, verifyActionOtpSchema } from "../../schemas/fms/action-otp.schema";
import * as controller from "../../controllers/fms/action-otp.controller";

const router = Router();

router.use(authenticate);

router.post(
  "/request-action",
  authRateLimiter,
  validate(requestActionOtpSchema, "body"),
  controller.requestActionOtp
);
router.post(
  "/verify-action",
  authRateLimiter,
  validate(verifyActionOtpSchema, "body"),
  controller.verifyActionOtp
);

export default router;
