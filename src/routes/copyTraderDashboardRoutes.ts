import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getActiveProTrades,
  getProTradeById,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// Active pro-trade discovery requires an authenticated copy trader.
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

copyTraderDashboardRouter.get("/trades", getActiveProTrades);
copyTraderDashboardRouter.get("/trades/:tradeId", getProTradeById);

export default copyTraderDashboardRouter;
