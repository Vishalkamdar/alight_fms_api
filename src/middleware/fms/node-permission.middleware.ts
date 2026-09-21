import { NextFunction, Request, Response } from "express";
import { AppError } from "../../utils/AppError";
import { hasAnyNodeRole } from "../../utils/fms/node-permission";
import type { FmsRole } from "../../models/fms/FmsUserNodeRole";
import type { AuthenticatedRequest } from "../auth";

export interface NodeScopedRequest extends AuthenticatedRequest {
  nodeAccess?: { nodeId: string; roles: FmsRole[] };
}

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * Resolves the target node id a future FMS API is acting on. Checked in
 * params, then body, then query, in that fixed order — the resolved id is
 * exactly what downstream handlers see and validate access for, so a
 * caller can't smuggle a different node id through another channel and
 * have it silently ignored.
 */
export function resolveNodeId(req: Request): string | null {
  const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

  const candidates = [req.params.nodeId, body.nodeId, body.node, req.query.nodeId];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && OBJECT_ID_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildNodeRoleMiddleware(roles: FmsRole[]) {
  return async (req: NodeScopedRequest, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      throw new AppError(401, "Authentication required.");
    }

    const nodeId = resolveNodeId(req);
    if (!nodeId) {
      throw new AppError(400, "A valid node id is required.");
    }

    const hasAccess = await hasAnyNodeRole(req.user._id, nodeId, roles);
    if (!hasAccess) {
      throw new AppError(403, "You do not have the required FMS role on this node.");
    }

    req.nodeAccess = { nodeId, roles };
    next();
  };
}

/** Require one specific FMS role on the resolved node, e.g. requireNodeRole("Maker"). */
export function requireNodeRole(role: FmsRole) {
  return buildNodeRoleMiddleware([role]);
}

/** Require any of several FMS roles, e.g. requireNodeRoles("Maker", "Verifier"). */
export function requireNodeRoles(...roles: FmsRole[]) {
  return buildNodeRoleMiddleware(roles);
}
