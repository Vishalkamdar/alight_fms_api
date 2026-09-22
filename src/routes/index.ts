import { Router } from "express";
import authRoutes from "./auth.routes";
import usersRoutes from "./users.routes";
import nodeTypeRoutes from "./node-type.routes";
import organizationNodeRoutes from "./organization-node.routes";
import userNodeRoleRoutes from "./fms/user-node-role.routes";
import nodeRoleConfigRoutes from "./fms/node-role-config.routes";
import systemConfigRoutes from "./fms/system-config.routes";
import schemeHeadNodeRoutes from "./fms/scheme-head-node.routes";
import configurationRoutes from "./fms/configuration.routes";
import otpProviderRoutes from "./fms/otp-provider.routes";
import actionOtpRoutes from "./fms/action-otp.routes";
import financialYearRoutes from "./fms/financial-year.routes";
import activityLogRoutes from "./activity-log.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", usersRoutes);
router.use("/activity-logs", activityLogRoutes);
router.use("/fms/node-types", nodeTypeRoutes);
router.use("/fms/organization-nodes", organizationNodeRoutes);
router.use("/fms/node-role-config", nodeRoleConfigRoutes);
router.use("/fms/system-config", systemConfigRoutes);
router.use("/fms/scheme-head-nodes", schemeHeadNodeRoutes);
router.use("/fms/configuration", configurationRoutes);
router.use("/fms/otp-providers", otpProviderRoutes);
router.use("/fms/otp", actionOtpRoutes);
router.use("/fms/financial-years", financialYearRoutes);
// Exposes /fms/user-node-roles, /fms/users/:userId/nodes, /fms/nodes/:nodeId/users,
// /fms/my-nodes, and /fms/my-nodes/:nodeId/role.
router.use("/fms", userNodeRoleRoutes);

export default router;
