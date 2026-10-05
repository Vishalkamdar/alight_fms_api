import { Response } from "express";
import { sendSuccess } from "../../utils/apiResponse";
import { getActorContextWithRole } from "../../utils/requestContext";
import * as budgetSetupService from "../../services/fms/budget-setup.service";
import * as budgetAllocationService from "../../services/fms/budget-allocation.service";
import * as fundTransferService from "../../services/fms/fund-transfer.service";
import type { AuthenticatedRequest } from "../../middleware/auth";

/**
 * The Approvals page's data source — everything the current user can act
 * on right now as Verifier or Checker, combined across every financial
 * module (Budget Setup, Budget Allocation, Fund Transfer — Pull/Return).
 */
export async function getMyPendingApprovals(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { actorId, actorRole } = getActorContextWithRole(req);
  const [budgetSetups, budgetAllocations, fundTransfers] = await Promise.all([
    budgetSetupService.getMyPendingBudgetSetups({ actorId, actorRole }),
    budgetAllocationService.getMyPendingBudgetAllocations({ actorId, actorRole }),
    fundTransferService.getMyPendingFundTransfers({ actorId, actorRole }),
  ]);

  sendSuccess(res, { budgetSetups, budgetAllocations, fundTransfers });
}
