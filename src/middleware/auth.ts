import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/AppError";
import { verifyAccessToken } from "../utils/jwt";
import { UserModel, UserDocument } from "../models/User";

export interface AuthenticatedRequest extends Request {
  user?: UserDocument;
}

async function resolveUserFromBearerToken(header: string | undefined): Promise<UserDocument | null> {
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length);
  const payload = verifyAccessToken(token); // throws on invalid/expired signature

  const user = await UserModel.findById(payload.sub);
  if (!user || !user.isActive) return null;

  // tokenVersion mismatch means the user changed their password or logged
  // out everywhere since this access token was issued — treat it as dead
  // even though its JWT signature/expiry are still technically valid.
  if (user.tokenVersion !== payload.tokenVersion) return null;

  return user;
}

export async function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  let user: UserDocument | null;
  try {
    user = await resolveUserFromBearerToken(req.headers.authorization);
  } catch {
    throw new AppError(401, "Your session has expired. Please sign in again.");
  }

  if (!user) {
    throw new AppError(401, "Your session has expired. Please sign in again.");
  }

  req.user = user;
  next();
}

/** Like `authenticate`, but never rejects — anonymous requests just get req.user = undefined. */
export async function optionalAuthenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await resolveUserFromBearerToken(req.headers.authorization);
    if (user) req.user = user;
  } catch {
    // Invalid/expired token on an optional route — treat the caller as anonymous.
  }
  next();
}
