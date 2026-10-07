import { Router } from "express";
import {
  activateUser,
  fetchAllUsers,
  suspendUser,
  fetchAuditLogs,
  getTrades,
  getTrade,
  getSettlements,
  getEarnings,
  getUserDetails,
} from "../controllers/adminDashboardController.js";
import { adminAuthenticate } from "../middleware/authenticationMiddleware.js";
import { listProWithdrawals, getProWithdrawal, reconcileWithdrawal, reconciliationLimit } from "../controllers/adminProWithdrawalController.js";

const adminDashboardRouter = Router();

// All routes require admin authentication
adminDashboardRouter.use(adminAuthenticate);
adminDashboardRouter.get("/pro/withdrawals", listProWithdrawals);
adminDashboardRouter.get("/pro/withdrawals/:id", getProWithdrawal);
adminDashboardRouter.post("/pro/withdrawals/:id/reconcile", reconciliationLimit, reconcileWithdrawal);

adminDashboardRouter.get("/users", fetchAllUsers);
adminDashboardRouter.get("/users/:id", getUserDetails);
adminDashboardRouter.patch("/users/:id/suspend", suspendUser);
adminDashboardRouter.patch("/users/:id/activate", activateUser);
adminDashboardRouter.get("/audit-logs", fetchAuditLogs);
adminDashboardRouter.get("/trades", getTrades);
adminDashboardRouter.get("/settlements", getSettlements);
adminDashboardRouter.get("/earnings", getEarnings);
adminDashboardRouter.get("/trades/:tradeId", getTrade);

export default adminDashboardRouter;
