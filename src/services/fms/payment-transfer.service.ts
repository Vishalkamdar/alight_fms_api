import crypto from "crypto";

/**
 * The seam between Expenditure's workflow and an actual bank/PSP
 * integration (§18) — nothing in expenditure.service.ts talks to a payment
 * provider directly, only to this interface, so a real provider can be
 * dropped in later (swap `paymentTransferProvider`'s assignment at the
 * bottom of this file) without touching the approval/payment-status state
 * machine at all.
 */
export interface PaymentTransferRequest {
  expenditureId: string;
  amount: number;
  paymentReference: string;
  bankSnapshot: {
    bankName: string;
    accountHolderName: string;
    maskedAccountNumber: string;
    ifscCode: string;
  };
}

export interface PaymentTransferResult {
  status: "SUCCESS" | "FAILED";
  providerReference?: string;
  failureReason?: string;
}

export interface PaymentTransferProvider {
  transfer(request: PaymentTransferRequest): Promise<PaymentTransferResult>;
}

/**
 * No real banking/payment API is connected yet — this always succeeds with
 * a synthetic provider reference, which is enough to exercise and verify
 * the full approval→payment state machine (idempotency guard, bank
 * snapshot, status transitions) end to end before a real integration
 * exists. `paymentReference` (generated once per Expenditure, reused on
 * retry) is the idempotency key a real provider would also expect, so
 * swapping this out later requires no change to how the reference is
 * generated or stored.
 */
class StubPaymentTransferProvider implements PaymentTransferProvider {
  async transfer(request: PaymentTransferRequest): Promise<PaymentTransferResult> {
    return {
      status: "SUCCESS",
      providerReference: `STUB-${request.paymentReference}`,
    };
  }
}

export function generatePaymentReference(): string {
  return `EXP-${crypto.randomUUID()}`;
}

export const paymentTransferProvider: PaymentTransferProvider = new StubPaymentTransferProvider();
