import { Types } from "mongoose";
import { FmsUserHeadRoleModel } from "../../models/fms/FmsUserHeadRole";
import { SchemeHeadNodeModel } from "../../models/SchemeHeadNode";

type IdLike = string | Types.ObjectId;

/** Every active Head assignment the user currently holds. */
export async function getUserHeads(userId: IdLike): Promise<string[]> {
  const assignments = await FmsUserHeadRoleModel.find({ user: userId, status: "Active" })
    .select("head")
    .lean();
  return assignments.map((assignment) => String(assignment.head));
}

/**
 * Every SchemeHeadNode id whose `hierarchyPath` descends from one of
 * `assignedHeadIds` (or is one of them) — simpler than the Organization
 * Node equivalent (getDescendantNodeIdsGovernedBy) since no
 * FmsNodeRoleConfig-style "is this level even configurable" gate exists
 * for Heads; it's a pure materialized-path prefix match against the live
 * tree, one query, no recursive walk.
 */
export async function getDescendantHeadIdsGovernedBy(assignedHeadIds: string[]): Promise<string[]> {
  if (assignedHeadIds.length === 0) return [];

  const assignedHeads = await SchemeHeadNodeModel.find({ _id: { $in: assignedHeadIds } })
    .select("_id hierarchyPath")
    .lean();
  if (assignedHeads.length === 0) return [];

  const allHeads = await SchemeHeadNodeModel.find({ status: "Active" }).select("_id hierarchyPath").lean();

  const result = new Set<string>();
  for (const assigned of assignedHeads) {
    const assignedId = String(assigned._id);
    const assignedFullPath = `${assigned.hierarchyPath}${assignedId}/`;
    result.add(assignedId);
    for (const head of allHeads) {
      if (head.hierarchyPath.startsWith(assignedFullPath)) {
        result.add(String(head._id));
      }
    }
  }
  return [...result];
}
