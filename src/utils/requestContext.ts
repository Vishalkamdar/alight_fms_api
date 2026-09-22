import { Types } from "mongoose";
import { AppError } from "./AppError";
import type { AuthenticatedRequest } from "../middleware/auth";

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
