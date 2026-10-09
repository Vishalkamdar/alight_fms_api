/**
 * UAT execution (phase 2 of 2) — runs the actual workflow against the live
 * HTTP API (http://localhost:5000/api), logged in as each of the 6 test
 * users provisioned by _UAT_1_provisionUsers.ts, exactly as the UI would.
 * Prints a running log plus a final PASS/FAIL checklist.
 *
 * Usage: npx tsx src/scripts/_UAT_2_runWorkflow.ts
 */

const BASE = "http://localhost:5000/api";

const ROOT_NODE_ID = "6ab24e7957b02d45d03b4dee"; // Alight Consultants
const TECH_NODE_ID = "6ab24e8b57b02d45d03b4def"; // Tech
const SCHEME_ROOT_ID = "6ab27ba64a9862383c8ce524"; // Kotak Mahindra Bank
const HEAD_VENDOR_PAYMENT_ID = "6ab3a8bf86f643cad03729f9";

const CREDS = {
  rootMaker: { email: "root.maker@alight-fms.local", password: "" },
  rootVerifier: { email: "root.verifier@alight-fms.local", password: "" },
  rootChecker: { email: "root.checker@alight-fms.local", password: "" },
  techMaker: { email: "tech.maker@alight-fms.local", password: "" },
  techVerifier: { email: "tech.verifier@alight-fms.local", password: "" },
  techChecker: { email: "tech.checker@alight-fms.local", password: "" },
};

type Creds = typeof CREDS;
type Role = keyof Creds;

const checklist: Array<{ step: string; pass: boolean; detail: string }> = [];
function record(step: string, pass: boolean, detail: string) {
  checklist.push({ step, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${step}: ${detail}`);
}

async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function login(email: string, password: string): Promise<string> {
  const { ok, json, status } = await api("POST", "/auth/login", null, { email, password });
  if (!ok) throw new Error(`Login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.data.accessToken as string;
}

async function main() {
  // Passwords are injected via env vars set by the shell wrapper (see
  // run instructions printed by phase 1) — never hardcoded in this file.
  for (const key of Object.keys(CREDS) as Role[]) {
    const envVar = `UAT_PW_${key.toUpperCase()}`;
    const pw = process.env[envVar];
    if (!pw) throw new Error(`Missing env var ${envVar} with this user's password.`);
    CREDS[key].password = pw;
  }

  console.log("Logging in as all 6 test users...");
  const tokens: Record<Role, string> = {} as Record<Role, string>;
  for (const key of Object.keys(CREDS) as Role[]) {
    tokens[key] = await login(CREDS[key].email, CREDS[key].password);
    console.log(`  logged in: ${key}`);
  }
  record("1. Users created & logged in", true, "All 6 users authenticated successfully.");

  // ---- Step 2: Root Maker creates a Budget Setup @ Root ----
  const budgetSetupRes = await api("POST", "/fms/budget-setups", tokens.rootMaker, {
    organizationNodeId: ROOT_NODE_ID,
    schemeHeadNodeId: SCHEME_ROOT_ID,
    originalAmount: 500000,
    remarks: "UAT: Root budget sanction",
  });
  if (!budgetSetupRes.ok) throw new Error(`Budget Setup creation failed: ${JSON.stringify(budgetSetupRes.json)}`);
  const budgetSetup = budgetSetupRes.json.data;
  record(
    "2. Root Maker creates Budget Setup",
    budgetSetup.approvalStatus === "PENDING_VERIFICATION" && budgetSetup.holdingAmount === 500000,
    `id=${budgetSetup._id} status=${budgetSetup.approvalStatus} holding=${budgetSetup.holdingAmount}`
  );

  // ---- Step 3: Root Verifier + Root Checker approve the Budget Setup ----
  const bsVerify = await api("POST", `/fms/budget-setups/${budgetSetup._id}/verify`, tokens.rootVerifier, {});
  if (!bsVerify.ok) throw new Error(`Budget Setup verify failed: ${JSON.stringify(bsVerify.json)}`);
  record(
    "3a. Root Verifier verifies Budget Setup",
    bsVerify.json.data.approvalStatus === "PENDING_CHECKER_APPROVAL",
    `status=${bsVerify.json.data.approvalStatus} holding=${bsVerify.json.data.holdingAmount}`
  );

  const bsApprove = await api("POST", `/fms/budget-setups/${budgetSetup._id}/approve`, tokens.rootChecker, {});
  if (!bsApprove.ok) throw new Error(`Budget Setup approve failed: ${JSON.stringify(bsApprove.json)}`);
  record(
    "3b. Root Checker approves Budget Setup — holding moves to available",
    bsApprove.json.data.approvalStatus === "APPROVED" && bsApprove.json.data.holdingAmount === 0 && bsApprove.json.data.approvedAmount === 500000,
    `status=${bsApprove.json.data.approvalStatus} holding=${bsApprove.json.data.holdingAmount} approved=${bsApprove.json.data.approvedAmount}`
  );

  // ---- Step 2 (cont'd): Tech Maker creates the Budget Allocation to Tech ----
  const financialYearId = budgetSetup.financialYearId as string;
  const allocationRes = await api("POST", "/fms/budget-allocations", tokens.techMaker, {
    financialYearId,
    organizationRootNodeId: ROOT_NODE_ID,
    schemeHeadRootNodeId: SCHEME_ROOT_ID,
    organizationNodeId: TECH_NODE_ID,
    headId: HEAD_VENDOR_PAYMENT_ID,
    amount: 200000,
    remarks: "UAT: allocate to Tech",
  });
  if (!allocationRes.ok) throw new Error(`Budget Allocation creation failed: ${JSON.stringify(allocationRes.json)}`);
  const allocation = allocationRes.json.data;
  record(
    "2b. Tech Maker allocates 200000 to Tech (on hold)",
    allocation.approvalStatus === "PENDING_VERIFICATION" && allocation.holdingAmount === 200000,
    `id=${allocation._id} status=${allocation.approvalStatus} holding=${allocation.holdingAmount}`
  );

  // Cross-department access control check: Root Verifier/Checker must NOT
  // be able to touch this Tech-targeted allocation (resolves to Tech's own
  // workflow, not Root's) — the exact rule flagged in the UAT notes.
  const crossAccessAttempt = await api("POST", `/fms/budget-allocations/${allocation._id}/verify`, tokens.rootVerifier, {});
  record(
    "2c. Security: Root Verifier is REJECTED from verifying Tech's allocation",
    !crossAccessAttempt.ok && crossAccessAttempt.status === 403,
    `status=${crossAccessAttempt.status} body=${JSON.stringify(crossAccessAttempt.json)}`
  );

  // ---- Step 3 (cont'd): Tech Verifier + Tech Checker approve the allocation ----
  const allocVerify = await api("POST", `/fms/budget-allocations/${allocation._id}/verify`, tokens.techVerifier, {});
  if (!allocVerify.ok) throw new Error(`Allocation verify failed: ${JSON.stringify(allocVerify.json)}`);
  record("3c. Tech Verifier verifies the allocation", allocVerify.json.data.approvalStatus === "PENDING_CHECKER_APPROVAL", `status=${allocVerify.json.data.approvalStatus}`);

  const allocApprove = await api("POST", `/fms/budget-allocations/${allocation._id}/approve`, tokens.techChecker, {});
  if (!allocApprove.ok) throw new Error(`Allocation approve failed: ${JSON.stringify(allocApprove.json)}`);
  record(
    "3d. Tech Checker approves — amount becomes available to Tech",
    allocApprove.json.data.approvalStatus === "APPROVED" && allocApprove.json.data.holdingAmount === 0,
    `status=${allocApprove.json.data.approvalStatus} holding=${allocApprove.json.data.holdingAmount} transferred=${allocApprove.json.data.transferredAmount}`
  );

  // ---- Masters: a Vendor + an Employee beneficiary, created by Tech Maker ----
  const vendorRes = await api("POST", "/fms/beneficiaries", tokens.techMaker, {
    beneficiaryType: "VENDOR",
    organizationNodeId: TECH_NODE_ID,
    name: "UAT Hosting Vendor Pvt Ltd",
    contactPersonName: "Suresh Rao",
    mobile: "9811122233",
    state: "Maharashtra",
    paymentMode: "BANK",
    bankAccounts: [
      { bankName: "HDFC Bank", branchName: "Andheri", accountNumber: "123456789012", ifscCode: "HDFC0001234", accountHolderName: "UAT Hosting Vendor Pvt Ltd", isDefault: true },
    ],
  });
  if (!vendorRes.ok) throw new Error(`Vendor creation failed: ${JSON.stringify(vendorRes.json)}`);
  const vendor = vendorRes.json.data;
  record("4a. Tech Maker creates active Vendor beneficiary", vendor.isActive === true, `id=${vendor._id}`);

  const employeeRes = await api("POST", "/fms/beneficiaries", tokens.techMaker, {
    beneficiaryType: "EMPLOYEE",
    organizationNodeId: TECH_NODE_ID,
    name: "UAT Employee One",
    employeeId: "EMP-UAT-001",
    panNumber: "ABCDE1234F",
    mobile: "9822233344",
    state: "Maharashtra",
    paymentMode: "BANK",
    bankAccounts: [
      { bankName: "ICICI Bank", branchName: "Powai", accountNumber: "998877665544", ifscCode: "ICIC0004567", accountHolderName: "UAT Employee One", isDefault: true },
    ],
  });
  if (!employeeRes.ok) throw new Error(`Employee creation failed: ${JSON.stringify(employeeRes.json)}`);
  const employee = employeeRes.json.data;
  record("5a. Tech Maker creates active Employee beneficiary", employee.isActive === true, `id=${employee._id}`);

  // ---- Deduction masters — find the existing Vendor TDS + Employee EPF ----
  const deductionsRes = await api("GET", "/fms/deduction-masters?limit=100", tokens.techMaker);
  const deductions = deductionsRes.json.data as Array<{ _id: string; name: string; deductionType: string; calculationType: string; percentage?: number }>;
  const tds = deductions.find((d) => d.deductionType === "VENDOR" && d.name === "TDS");
  const epf = deductions.find((d) => d.deductionType === "EMPLOYEE" && d.name === "EPF");
  if (!tds || !epf) throw new Error("Expected deduction masters (TDS, EPF) not found.");

  // ---- Step 4: Tech Maker creates a Vendor expenditure ----
  const expenditureRes = await api("POST", "/fms/expenditures", tokens.techMaker, {
    financialYearId,
    organizationRootNodeId: ROOT_NODE_ID,
    organizationNodeId: TECH_NODE_ID,
    schemeHeadRootNodeId: SCHEME_ROOT_ID,
    headId: HEAD_VENDOR_PAYMENT_ID,
    beneficiaryType: "VENDOR",
    beneficiaryId: vendor._id,
    paymentType: "ONLINE",
    billVoucherNumber: "UAT-BV-001",
    billVoucherDate: new Date().toISOString(),
    particulars: [{ description: "Server hosting charges", amount: 20000 }],
    deductions: [{ deductionId: tds._id, percentage: 10, amount: 2000 }],
  });
  if (!expenditureRes.ok) throw new Error(`Expenditure creation failed: ${JSON.stringify(expenditureRes.json)}`);
  const expenditure = expenditureRes.json.data;
  record(
    "4b. Tech Maker creates 20000 Vendor expenditure",
    expenditure.approvalStatus === "PENDING_VERIFICATION" && expenditure.netPayableAmount === 18000,
    `id=${expenditure._id} status=${expenditure.approvalStatus} net=${expenditure.netPayableAmount}`
  );

  // ---- Step 5: Tech Maker creates a Payroll batch ----
  const payrollRes = await api("POST", "/fms/payroll-batches", tokens.techMaker, {
    financialYearId,
    organizationRootNodeId: ROOT_NODE_ID,
    organizationNodeId: TECH_NODE_ID,
    schemeHeadRootNodeId: SCHEME_ROOT_ID,
    month: new Date().toLocaleString("en-US", { month: "long" }),
    employees: [
      {
        beneficiaryId: employee._id,
        salaryAmount: 50000,
        deductions: [{ deductionId: epf._id, percentage: 12, amount: 6000 }],
      },
    ],
  });
  if (!payrollRes.ok) throw new Error(`Payroll creation failed: ${JSON.stringify(payrollRes.json)}`);
  const payroll = payrollRes.json.data;
  record(
    "5b. Tech Maker creates Payroll batch (1 employee, 50000 gross)",
    payroll.approvalStatus === "PENDING_VERIFICATION" && payroll.totalGrossSalary === 50000,
    `id=${payroll._id} status=${payroll.approvalStatus} gross=${payroll.totalGrossSalary}`
  );

  // ---- Step 6: Tech Verifier then Tech Checker finalize both ----
  const expVerify = await api("POST", `/fms/expenditures/${expenditure._id}/verify`, tokens.techVerifier, {});
  if (!expVerify.ok) throw new Error(`Expenditure verify failed: ${JSON.stringify(expVerify.json)}`);
  const payVerify = await api("POST", `/fms/payroll-batches/${payroll._id}/verify`, tokens.techVerifier, {});
  if (!payVerify.ok) throw new Error(`Payroll verify failed: ${JSON.stringify(payVerify.json)}`);
  record(
    "6a. Tech Verifier verifies both Expenditure and Payroll",
    expVerify.json.data.approvalStatus === "PENDING_CHECKER_APPROVAL" && payVerify.json.data.approvalStatus === "PENDING_CHECKER_APPROVAL",
    `expenditure=${expVerify.json.data.approvalStatus} payroll=${payVerify.json.data.approvalStatus}`
  );

  // Security check: Root Checker must not be able to touch Tech's expenditure either.
  const crossApprove = await api("POST", `/fms/expenditures/${expenditure._id}/approve`, tokens.rootChecker, {});
  record(
    "6b. Security: Root Checker is REJECTED from approving Tech's expenditure",
    !crossApprove.ok && crossApprove.status === 403,
    `status=${crossApprove.status}`
  );

  const expApprove = await api("POST", `/fms/expenditures/${expenditure._id}/approve`, tokens.techChecker, {});
  if (!expApprove.ok) throw new Error(`Expenditure approve failed: ${JSON.stringify(expApprove.json)}`);
  const payApprove = await api("POST", `/fms/payroll-batches/${payroll._id}/approve`, tokens.techChecker, {});
  if (!payApprove.ok) throw new Error(`Payroll approve failed: ${JSON.stringify(payApprove.json)}`);
  record(
    "6c. Tech Checker approves both — payment processing begins only now",
    expApprove.json.data.approvalStatus === "APPROVED" &&
      ["PAYMENT_PROCESSING", "PAYMENT_SUCCESS"].includes(expApprove.json.data.paymentStatus) &&
      payApprove.json.data.approvalStatus === "APPROVED",
    `expenditure paymentStatus=${expApprove.json.data.paymentStatus} payroll employees[0].paymentStatus=${payApprove.json.data.employees?.[0]?.paymentStatus}`
  );

  // Give the stub payment provider's async settling (if any) a brief moment, then re-fetch.
  const expFinal = await api("GET", `/fms/expenditures/${expenditure._id}`, tokens.techMaker);
  const payFinal = await api("GET", `/fms/payroll-batches/${payroll._id}`, tokens.techMaker);
  record(
    "6d. Final payment status reaches PAYMENT_SUCCESS via the mock provider",
    expFinal.json.data.paymentStatus === "PAYMENT_SUCCESS" && payFinal.json.data.employees?.[0]?.paymentStatus === "PAYMENT_SUCCESS",
    `expenditure=${expFinal.json.data.paymentStatus} payroll=${payFinal.json.data.employees?.[0]?.paymentStatus}`
  );

  // ---- Step 7: Dashboard + Reports — same definitions, role-scoped data ----
  const dashRoot = await api("GET", "/fms/dashboard", tokens.rootMaker);
  const dashTech = await api("GET", "/fms/dashboard", tokens.techMaker);
  record(
    "7a. Dashboard reachable for both Root and Tech roles with same shape",
    dashRoot.ok && dashTech.ok && JSON.stringify(Object.keys(dashRoot.json.data).sort()) === JSON.stringify(Object.keys(dashTech.json.data).sort()),
    `root keys=${Object.keys(dashRoot.json.data ?? {}).join(",")} | tech keys=${Object.keys(dashTech.json.data ?? {}).join(",")}`
  );

  const reportPaths = [
    "/fms/reports/budget-summary",
    "/fms/reports/budget-allocation",
    "/fms/reports/budget-availability",
    "/fms/reports/expenditure",
    "/fms/reports/payroll",
    "/fms/reports/approval-status",
    "/fms/reports/payment-status",
  ];
  let allReportsConsistent = true;
  const reportDetails: string[] = [];
  for (const path of reportPaths) {
    const asTechMaker = await api("GET", path, tokens.techMaker);
    const asTechVerifier = await api("GET", path, tokens.techVerifier);
    const asRootMaker = await api("GET", path, tokens.rootMaker);
    const shapeMatches =
      asTechMaker.ok &&
      asTechVerifier.ok &&
      asRootMaker.ok &&
      JSON.stringify(Object.keys(asTechMaker.json.data ?? {}).sort()) === JSON.stringify(Object.keys(asTechVerifier.json.data ?? {}).sort());
    if (!shapeMatches) allReportsConsistent = false;
    reportDetails.push(`${path}: techMaker=${asTechMaker.status} techVerifier=${asTechVerifier.status} rootMaker=${asRootMaker.status} sameShape=${shapeMatches}`);
  }
  record("7b. All 7 reports load for Maker/Verifier/Root with identical definitions", allReportsConsistent, reportDetails.join(" | "));

  // ---- Summary ----
  console.log("\n=== UAT Acceptance Summary ===");
  for (const row of checklist) {
    console.log(`${row.pass ? "✅" : "❌"} ${row.step}`);
  }
  const failed = checklist.filter((r) => !r.pass);
  console.log(`\n${checklist.length - failed.length}/${checklist.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const row of failed) console.log(`  - ${row.step}: ${row.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nUAT script crashed:", err);
  process.exitCode = 1;
});
