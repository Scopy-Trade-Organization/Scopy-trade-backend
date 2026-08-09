import { Router } from "express";
import {
  activateUser,
  fetchAllUsers,
  getAllSignals,
  suspendUser,
  fetchAuditLogs,
  getTrades,
  getTrade,
} from "../controllers/adminDashboardController.js";
import { adminAuthenticate } from "../middleware/authenticationMiddleware.js";

const adminDashboardRouter = Router();

// All routes require admin authentication
adminDashboardRouter.use(adminAuthenticate);

adminDashboardRouter.get("/signals", getAllSignals);
adminDashboardRouter.get("/users", fetchAllUsers);
adminDashboardRouter.patch("/users/:id/suspend", suspendUser);
adminDashboardRouter.patch("/users/:id/activate", activateUser);
adminDashboardRouter.get("/audit-logs", fetchAuditLogs);
adminDashboardRouter.get("/trades", getTrades);
adminDashboardRouter.get("/trades/:tradeId", getTrade);

export default adminDashboardRouter;
