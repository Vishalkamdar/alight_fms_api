import { z } from "zod";

const actionOtpPurposeEnum = z.enum(["VERIFIER_ACTION", "CHECKER_ACTION"]);

export const requestActionOtpSchema = z.object({
  purpose: actionOtpPurposeEnum,
  action: z.string().trim().min(1, "Action is required.").max(100),
  transactionId: z.string().trim().min(1, "Transaction id is required.").max(100),
  nodeId: z.string().trim().min(1, "Node id is required.").max(100),
});

export const verifyActionOtpSchema = requestActionOtpSchema.extend({
  otp: z.string().trim().min(4, "Enter the OTP.").max(10).regex(/^\d+$/, "OTP must contain digits only."),
});

export type RequestActionOtpInput = z.infer<typeof requestActionOtpSchema>;
export type VerifyActionOtpInput = z.infer<typeof verifyActionOtpSchema>;
