import { Router } from "express";
import authRoutes from "./auth.routes";
import usersRoutes from "./users.routes";
import nodeTypeRoutes from "./node-type.routes";
import organizationNodeRoutes from "./organization-node.routes";
import userNodeRoleRoutes from "./fms/user-node-role.routes";
import nodeRoleConfigRoutes from "./fms/node-role-config.routes";
import systemConfigRoutes from "./fms/system-config.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", usersRoutes);
router.use("/fms/node-types", nodeTypeRoutes);
router.use("/fms/organization-nodes", organizationNodeRoutes);
router.use("/fms/node-role-config", nodeRoleConfigRoutes);
router.use("/fms/system-config", systemConfigRoutes);
// Exposes /fms/user-node-roles, /fms/users/:userId/nodes, /fms/nodes/:nodeId/users,
// /fms/my-nodes, and /fms/my-nodes/:nodeId/role.
router.use("/fms", userNodeRoleRoutes);

export default router;
