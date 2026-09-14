import { Router } from "express";
import {
  userAuthenticate,
  requireRole,
} from "../middleware/authenticationMiddleware.js";
import {
  getActiveProTrades,
  approveProfitShare,
  getProfitShare,
  getProTradeById,
} from "../controllers/copyTraderDashboardController.js";

const copyTraderDashboardRouter = Router();

// Active pro-trade discovery requires an authenticated copy trader.
copyTraderDashboardRouter.use(userAuthenticate);
copyTraderDashboardRouter.use(requireRole(["CopyTrader"]));

copyTraderDashboardRouter.get("/trades", getActiveProTrades);
copyTraderDashboardRouter.get("/trades/:tradeId", getProTradeById);
copyTraderDashboardRouter.get("/profit-share", getProfitShare);
copyTraderDashboardRouter.post("/profit-share/approve", approveProfitShare);

export default copyTraderDashboardRouter;
