import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getSignalById,
  getActiveSignals,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// All signal routes require authentication
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

copyTraderDashboardRouter.get("/signals", getActiveSignals);

copyTraderDashboardRouter.get("/signals/:signalId", getSignalById);

export default copyTraderDashboardRouter;
