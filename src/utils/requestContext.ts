import { Types } from "mongoose";
import { AppError } from "./AppError";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { UserRole } from "../models/User";

export interface ActorContext {
  actorId: Types.ObjectId;
  ipAddress: string | null;
  userAgent: string | null;
}

export function getActorContext(req: AuthenticatedRequest): ActorContext {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return {
    actorId: req.user._id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

export interface ActorContextWithRole extends ActorContext {
  actorRole: UserRole;
}

/** For anything gated by the Maker/Verifier/Checker workflow — needs the app-level role to apply the Super Admin bypass. */
export function getActorContextWithRole(req: AuthenticatedRequest): ActorContextWithRole {
  if (!req.user) throw new AppError(401, "Authentication required.");
  return { ...getActorContext(req), actorRole: req.user.role };
}
