/**
 * One-time backfill for the "no negative balance" fix (see
 * reserveFromParentIfNeeded in budget-allocation.service.ts). Every
 * BudgetAllocation created BEFORE that fix shipped reserved its money only
 * against the root Budget Setup pool — it never touched its parent node's
 * new `subAllocatedAmount` counter, because that counter didn't exist yet.
 * Without this backfill, every pre-existing child allocation would be
 * invisible to the new parent-balance check, so a node that's already
 * over-committed (e.g. Tech showing a negative remaining fund) would
 * silently report itself as fully available again — re-opening the exact
 * bug this fix closes.
 *
 * For every non-root-level node that has received money, this distributes
 * its children's existing (non-rejected) allocation amounts across its own
 * APPROVED received allocation(s), oldest-first — exactly how
 * reserveFromParentIfNeeded would have reserved them had the counter
 * existed at creation time — and records the matching `parentSourcePools`
 * breakdown on each child so future rejections still release correctly.
 *
 * Per GLOBAL_RULES §13, an already-over-committed node is never silently
 * "fixed" by inflating its capacity — its pool(s) simply end up fully
 * consumed (subAllocatedAmount capped at amount), which is the honest
 * state, and is logged loudly so it can be investigated. From that point
 * on, the normal reservation guard prevents any further allocation out of
 * it until the inconsistency is resolved.
 *
 * Usage:
 *   npx tsx src/scripts/backfillBudgetAllocationParentPools.ts           (dry run — prints only)
 *   npx tsx src/scripts/backfillBudgetAllocationParentPools.ts --apply   (writes)
 */
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../config/db";
import { BudgetAllocationModel } from "../models/fms/BudgetAllocation";
import { OrganizationNodeModel } from "../models/OrganizationNode";

interface ChildRow {
  _id: Types.ObjectId;
  organizationNodeId: Types.ObjectId;
  financialYearId: Types.ObjectId;
  organizationRootNodeId: Types.ObjectId;
  schemeHeadRootNodeId: Types.ObjectId;
  amount: number;
  approvalStatus: string;
  createdAt: Date;
}

interface ParentPoolRow {
  _id: Types.ObjectId;
  amount: number;
  createdAt: Date;
}

function scopeKey(fields: { financialYearId: Types.ObjectId; organizationRootNodeId: Types.ObjectId; schemeHeadRootNodeId: Types.ObjectId; nodeId: Types.ObjectId }): string {
  return `${fields.financialYearId}|${fields.organizationRootNodeId}|${fields.schemeHeadRootNodeId}|${fields.nodeId}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  await connectDatabase();

  const [orgNodes, allAllocations] = await Promise.all([
    OrganizationNodeModel.find({}).select("_id parentNodeId").lean(),
    BudgetAllocationModel.find({})
      .select("organizationNodeId financialYearId organizationRootNodeId schemeHeadRootNodeId amount approvalStatus createdAt")
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const parentNodeById = new Map(orgNodes.map((n) => [String(n._id), n.parentNodeId ? String(n.parentNodeId) : null]));

  const nonRejected = allAllocations.filter(
    (a) => a.approvalStatus !== "REJECTED_BY_VERIFIER" && a.approvalStatus !== "REJECTED_BY_CHECKER"
  ) as unknown as ChildRow[];
  const approvedOnly = allAllocations.filter((a) => a.approvalStatus === "APPROVED") as unknown as ParentPoolRow[] &
    Array<{ organizationNodeId: Types.ObjectId; financialYearId: Types.ObjectId; organizationRootNodeId: Types.ObjectId; schemeHeadRootNodeId: Types.ObjectId }>;

  // Group children needing a parent check (parent exists and isn't the scope root).
  const childrenByParentScope = new Map<string, ChildRow[]>();
  for (const child of nonRejected) {
    const parentNodeId = parentNodeById.get(String(child.organizationNodeId));
    if (!parentNodeId) continue;
    if (parentNodeId === String(child.organizationRootNodeId)) continue; // root-level target — no parent pool involved
    const key = scopeKey({
      financialYearId: child.financialYearId,
      organizationRootNodeId: child.organizationRootNodeId,
      schemeHeadRootNodeId: child.schemeHeadRootNodeId,
      nodeId: new Types.ObjectId(parentNodeId),
    });
    const list = childrenByParentScope.get(key) ?? [];
    list.push(child);
    childrenByParentScope.set(key, list);
  }

  // Index approved docs (candidate parent pools) by their own scope key.
  const approvedByScope = new Map<string, ParentPoolRow[]>();
  for (const doc of approvedOnly) {
    const key = scopeKey({
      financialYearId: doc.financialYearId,
      organizationRootNodeId: doc.organizationRootNodeId,
      schemeHeadRootNodeId: doc.schemeHeadRootNodeId,
      nodeId: doc.organizationNodeId,
    });
    const list = approvedByScope.get(key) ?? [];
    list.push(doc);
    approvedByScope.set(key, list);
  }

  const childUpdates = new Map<string, Array<{ parentAllocationId: Types.ObjectId; amount: number }>>(); // child _id -> parentSourcePools
  let flaggedCount = 0;

  for (const [key, children] of childrenByParentScope) {
    const pools = (approvedByScope.get(key) ?? []).slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const poolRemaining = new Map(pools.map((p) => [String(p._id), p.amount]));
    const totalReceived = pools.reduce((sum, p) => sum + p.amount, 0);
    const totalNeeded = children.reduce((sum, c) => sum + c.amount, 0);

    if (pools.length === 0) {
      flaggedCount += 1;
      console.warn(
        `[FLAG] Parent node has ${children.length} existing child allocation(s) totaling ${totalNeeded}, but has NO approved allocation of its own in this scope. Parent key: ${key}`
      );
    } else if (totalNeeded > totalReceived) {
      flaggedCount += 1;
      console.warn(
        `[FLAG] Parent node over-committed: children total ${totalNeeded} exceeds its own received ${totalReceived} by ${totalNeeded - totalReceived}. Parent key: ${key}`
      );
    }

    const sortedChildren = children.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const child of sortedChildren) {
      let remaining = child.amount;
      const breakdown: Array<{ parentAllocationId: Types.ObjectId; amount: number }> = [];
      for (const pool of pools) {
        if (remaining <= 0) break;
        const available = poolRemaining.get(String(pool._id)) ?? 0;
        if (available <= 0) continue;
        const draw = Math.min(available, remaining);
        poolRemaining.set(String(pool._id), available - draw);
        breakdown.push({ parentAllocationId: pool._id, amount: draw });
        remaining -= draw;
      }
      // Whatever couldn't be covered (remaining > 0) is the historical
      // over-commitment — left unreserved on purpose rather than fabricated.
      if (breakdown.length > 0) childUpdates.set(String(child._id), breakdown);
    }
  }

  console.log(`\nScanned ${allAllocations.length} Budget Allocation record(s).`);
  console.log(`Parent scopes needing backfill: ${childrenByParentScope.size}`);
  console.log(`Flagged pre-existing over-commitments: ${flaggedCount}`);
  console.log(`Child records to receive parentSourcePools: ${childUpdates.size}`);

  if (!apply) {
    console.log("\nDry run only — re-run with --apply to write these changes.");
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const [childId, breakdown] of childUpdates) {
    await BudgetAllocationModel.updateOne({ _id: childId }, { $set: { parentSourcePools: breakdown } });
    written += 1;
  }

  // Recompute each parent pool's consumed amount directly from the final breakdowns.
  const consumedByPool = new Map<string, number>();
  for (const breakdown of childUpdates.values()) {
    for (const entry of breakdown) {
      consumedByPool.set(String(entry.parentAllocationId), (consumedByPool.get(String(entry.parentAllocationId)) ?? 0) + entry.amount);
    }
  }
  for (const [poolId, amount] of consumedByPool) {
    await BudgetAllocationModel.updateOne({ _id: poolId }, { $set: { subAllocatedAmount: amount } });
  }

  console.log(`\nApplied: ${written} child record(s) updated with parentSourcePools, ${consumedByPool.size} parent pool(s) updated with subAllocatedAmount.`);
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
