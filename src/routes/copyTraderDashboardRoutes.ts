import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getSignalById,
  getActiveSignals,
  getActiveProTrades,
  getProTradeById,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// All signal routes require authentication
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

copyTraderDashboardRouter.get("/signals", getActiveSignals);

copyTraderDashboardRouter.get("/signals/:signalId", getSignalById);

copyTraderDashboardRouter.get("/trades", getActiveProTrades);
copyTraderDashboardRouter.get("/trades/:tradeId", getProTradeById);

export default copyTraderDashboardRouter;
