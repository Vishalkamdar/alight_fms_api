import { Types } from "mongoose";
import { FmsAuditLogModel, type FmsAuditEntity } from "../../models/fms/FmsAuditLog";

interface RecordAuditParams {
  user: Types.ObjectId;
  action: string;
  entity: FmsAuditEntity;
  entityId?: Types.ObjectId | null;
  previousValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
}

export async function recordAudit(params: RecordAuditParams): Promise<void> {
  await FmsAuditLogModel.create({
    user: params.user,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId ?? null,
    previousValue: params.previousValue ?? null,
    newValue: params.newValue ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}
