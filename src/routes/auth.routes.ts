import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/authorize";
import { authRateLimiter, passwordResetRateLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  signupSchema,
} from "../schemas/auth.schema";
import * as authController from "../controllers/auth.controller";

const router = Router();

/**
 * Public self-registration is intentionally closed: with only "Super Admin"
 * and "Admin" as application roles, every account is administrative, so
 * user creation now requires an authenticated Admin/Super Admin caller
 * (also exposed as POST /api/users — this endpoint is kept for backward
 * compatibility with existing integrations).
 */
router.post(
  "/signup",
  authRateLimiter,
  authenticate,
  authorizeRoles("Admin", "Super Admin"),
  validate(signupSchema, "body"),
  authController.signup
);

router.post("/login", authRateLimiter, validate(loginSchema, "body"), authController.login);

router.post(
  "/refresh-token",
  authRateLimiter,
  validate(refreshTokenSchema, "body"),
  authController.refreshToken
);

router.post("/logout", validate(refreshTokenSchema, "body"), authController.logout);

router.post("/logout-all", authenticate, authController.logoutAll);

router.get("/me", authenticate, authController.me);

router.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema, "body"),
  authController.changePassword
);

router.post(
  "/forgot-password",
  passwordResetRateLimiter,
  validate(forgotPasswordSchema, "body"),
  authController.forgotPassword
);

router.post(
  "/reset-password",
  authRateLimiter,
  validate(resetPasswordSchema, "body"),
  authController.resetPassword
);

export default router;
