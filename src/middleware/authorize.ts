import { NextFunction, Response } from "express";
import { AppError } from "../utils/AppError";
import type { AuthenticatedRequest } from "./auth";
import type { UserRole } from "../models/User";

/**
 * Reusable role gate for any FMS route, e.g.:
 *   authorizeRoles("Admin")
 *   authorizeRoles("Admin", "Business Head")
 * Must run after `authenticate` so req.user is populated.
 */
export function authorizeRoles(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(401, "Authentication required.");
    }
    if (!roles.includes(req.user.role)) {
      throw new AppError(403, "You do not have permission to perform this action.");
    }
    next();
  };
}
